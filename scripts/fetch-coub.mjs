// Usage:
//   node fetch-from-timeline-json.mjs --from-json ./coub_timeline_xchrtf6x.json --out ./out --concurrency 4
// Flags:
//   --max 200          # ограничить количество
//   --prefer-share     # если нет html5.{video,audio}, брать готовый share.default (mp4) как видео
//   --loop-video       # дополнительно создать ...video.looped.mp4 с длительностью аудио (перекодируем в H.264)
//   --dry-run          # ничего не качать — только лог действий
// ENV:
//   COUB_COOKIE='COUB-SESSION=...'   # при необходимости доступа к 18+
//
// Результаты:
//   "<permalink> - <title>.video.<ext>"
//   "<permalink> - <title>.audio.<ext>" (если есть)
//   "<permalink> - <title>.video.looped.mp4" (при --loop-video)

import { readFile, mkdir, access, writeFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetch } from 'undici';
import { setTimeout as sleep } from 'node:timers/promises';
import { Writable } from 'node:stream';

const args = parseArgs(process.argv.slice(2));
const INPUT = args['from-json'];
const OUT_DIR = args.out || './out';
const CONCURRENCY = Number(args.concurrency || 4);
const MAX_ITEMS = args.max ? Number(args.max) : Infinity;
const PREFER_SHARE = Boolean(args['prefer-share']);
const LOOP_VIDEO = Boolean(args['loop-video']);
const DRY_RUN = Boolean(args['dry-run']);
const EXTRA_COOKIE = process.env.COUB_COOKIE || '';

if (!INPUT) {
  console.error('Укажи путь к JSON таймлайна: --from-json <file>');
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });

/* ---------- utils ---------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; }
      else out[k] = true;
    }
  }
  return out;
}

function sanitize(s = '') {
  return String(s).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fileExists(p) { try { await access(p); return true; } catch { return false; } }

function urlExt(u, fallback = '.mp4') {
  try {
    const ext = path.extname(new URL(u).pathname);
    return ext || fallback;
  } catch { return fallback; }
}

async function downloadToFile(url, outPath, { retries = 3 } = {}) {
  for (let a = 1; a <= retries; a++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Referer': 'https://coub.com/',
          ...(EXTRA_COOKIE ? { Cookie: EXTRA_COOKIE } : {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);

      const file = createWriteStream(outPath);

      // Web ReadableStream → Web WritableStream (над Node fs)
      if (res.body && typeof res.body.pipeTo === 'function') {
        await res.body.pipeTo(Writable.toWeb(file));
        return;
      }
      // fallback: Node stream
      if (res.body && typeof res.body.pipe === 'function') {
        await new Promise((resolve, reject) => {
          res.body.pipe(file);
          file.on('finish', resolve);
          file.on('error', reject);
        });
        return;
      }
      // fallback: буфером
      const ab = await res.arrayBuffer();
      await writeFile(outPath, Buffer.from(ab));
      return;

    } catch (e) {
      if (a === retries) throw e;
      await sleep(300 * a);
    }
  }
}

function pickUrl(obj) {
  if (!obj) return null;
  const order = ['higher', 'high', 'med', 'medium', 'low'];
  for (const k of order) {
    const v = obj[k];
    const u = typeof v === 'string' ? v
      : v?.url ? v.url
        : Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : v[0]?.url) : null;
    if (u) return u;
  }
  if (typeof obj === 'string') return obj;
  if (typeof obj.url === 'string') return obj.url;
  return null;
}

/** вернёт {permalink, title, videoUrl, audioUrl, shareUrl, targetDurationGuess} */
function extractMedia(item) {
  const raw = item?._raw ?? item ?? {};
  const src = raw?.recoub_to ?? raw;

  const permalink = raw?.recoub_to?.permalink || item?.permalink || raw?.permalink || null;
  const title = src?.title || item?.title || null;

  const fv = src?.file_versions || raw?.file_versions || {};
  const vHtml5 = fv?.html5?.video;
  const aHtml5 = fv?.html5?.audio;
  const vMobile = fv?.mobile?.video;
  const aMobile = fv?.mobile?.audio;
  const shareDefault = fv?.share?.default;

  const videoUrl = pickUrl(vHtml5) || pickUrl(vMobile) || null;
  const audioUrl = pickUrl(aHtml5) || pickUrl(aMobile) || null;

  // как запасная оценка длительности — поля duration из объекта
  const targetDurationGuess =
    src?.duration ?? raw?.duration ?? item?.duration ?? null;

  return { permalink, title, videoUrl, audioUrl, shareUrl: typeof shareDefault === 'string' ? shareDefault : null, targetDurationGuess };
}

function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => out += d);
    p.on('exit', () => {
      const val = parseFloat(out.trim());
      resolve(Number.isFinite(val) ? val : null);
    });
    p.on('error', () => resolve(null));
  });
}

/** создаёт зацикленный видеофайл длительностью targetSec (без аудио) */
async function makeLoopedVideo(srcVideo, targetSec, outPath) {
  if (!Number.isFinite(targetSec) || targetSec <= 0) throw new Error('Bad target duration');
  // Надёжно через бесконечный loop и обрезку по -t; перекодируем в h264
  // (копирование часто бьёт таймстемпы на MP4)
  const args = [
    '-y',
    '-stream_loop', '-1',
    '-i', srcVideo,
    '-t', String(targetSec),
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-crf', '18',
    '-movflags', '+faststart',
    outPath,
  ];
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: 'inherit' });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });
}

/* ---------- worker ---------- */
async function processOne(item, outDir) {
  const { permalink, title, videoUrl, audioUrl, shareUrl, targetDurationGuess } = extractMedia(item);
  if (!permalink) return { ok: false, reason: 'no-permalink' };

  const base = sanitize(permalink);
  const videoExt = videoUrl ? urlExt(videoUrl, '.mp4') : (PREFER_SHARE && shareUrl ? urlExt(shareUrl, '.mp4') : '.mp4');
  const audioExt = audioUrl ? urlExt(audioUrl, '.mp3') : null;

  const videoOut = path.join(outDir, `${base}.video${videoExt}`);
  const audioOut = audioExt ? path.join(outDir, `${base}.audio${audioExt}`) : null;

  if (DRY_RUN) {
    return { ok: true, skipped: true, reason: 'dry-run', permalink, videoUrl, audioUrl, shareUrl, title };
  }

  // Сначала видео
  if (await fileExists(videoOut)) {
    // ок
  } else if (videoUrl) {
    await downloadToFile(videoUrl, videoOut);
  } else if (PREFER_SHARE && shareUrl) {
    await downloadToFile(shareUrl, videoOut);
  } else {
    return { ok: false, reason: 'no-video', permalink, title };
  }

  // Потом аудио (если есть)
  if (audioOut) {
    if (!(await fileExists(audioOut))) {
      await downloadToFile(audioUrl, audioOut).catch(() => {});
    }
  }

  // Опционально — делаем зацикленное видео длиной аудио
  let loopedPath = null;
  if (LOOP_VIDEO && audioOut && await fileExists(audioOut)) {
    const audioDur = await ffprobeDuration(audioOut);
    const target = Number.isFinite(audioDur) ? audioDur : (Number(targetDurationGuess) || null);
    if (target && target > 0) {
      loopedPath = path.join(outDir, `${base}.video.looped.mp4`);
      await makeLoopedVideo(videoOut, target, loopedPath);
    }
  }

  return { ok: true, permalink, videoOut, audioOut, loopedPath, title };
}

/* ---------- run pool ---------- */
async function runPool(items, worker, concurrency) {
  const results = Array(items.length);
  let i = 0, active = 0;

  return await new Promise((resolve) => {
    const step = () => {
      while (active < concurrency && i < items.length) {
        const idx = i++;
        active++;
        worker(items[idx])
          .then(res => { results[idx] = res; })
          .catch(e => { results[idx] = { ok: false, error: e?.message || String(e) }; })
          .finally(() => {
            active--;
            if (i === items.length && active === 0) resolve(results);
            else step();
          });
      }
    };
    step();
  });
}

/* ---------- main ---------- */
const raw = JSON.parse(await readFile(INPUT, 'utf-8'));
const list = Array.isArray(raw) ? raw : [];
if (!list.length) {
  console.error('Пустой или неверный JSON таймлайна.');
  process.exit(1);
}

// дедуп по эффективному пермалинку (_raw.recoub_to.permalink ?? permalink)
const seen = new Set();
const items = [];
for (const it of list) {
  const eff = it?._raw?.recoub_to?.permalink || it?.permalink || it?._raw?.permalink;
  if (!eff) continue;
  if (seen.has(eff)) continue;
  seen.add(eff);
  items.push(it);
  if (items.length >= MAX_ITEMS) break;
}

console.log(`К обработке уникальных: ${items.length}`);
let done = 0;
const results = await runPool(items, async (it) => {
  const r = await processOne(it, OUT_DIR);
  done++;
  const eff = it?._raw?.recoub_to?.permalink || it?.permalink || it?._raw?.permalink;
  const tag = r.ok ? (r.loopedPath ? 'ok+loop' : 'ok') : 'fail';
  console.log(`[${done}/${items.length}] ${tag} ${eff} ${r.reason ? '('+r.reason+')' : ''}`);
  return { eff_permalink: eff, ...r };
}, CONCURRENCY);

await writeFile(path.join(OUT_DIR, 'report_separate.json'), JSON.stringify(results, null, 2), 'utf-8');
console.log('Готово.');
