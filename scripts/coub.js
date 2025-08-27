// Usage:
//   node dump-timeline.mjs xchrtf6x
//   COUB_COOKIE="COUB-SESSION=..." node dump-timeline.mjs xchrtf6x
//
// Сохранит: coub_timeline_xchrtf6x.json

import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetch } from 'undici';

const PERMALINK = process.argv[2];
if (!PERMALINK) {
  console.error('Provide channel permalink, e.g. `node coub.js xchrtf6x`');
  process.exit(1);
}

const BASE_URL = `https://coub.com/api/v2/timeline/channel/${encodeURIComponent(PERMALINK)}`;
const ORDER_BY = 'newest';           // можно 'newest' / 'oldest' / 'popular' — если поддерживается
const MAX_PAGES = 500;               // страховка, прерываемся раньше если пусто
const PAGE_DELAY_MS = 450;           // троттлинг между страницами
const PER_PAGE_HINT = 25;            // если сервер уважит per_page — будет быстрее

// Если нужны 18+ ролики — передай cookie через COUB_COOKIE, например:
// COUB_COOKIE='COUB-SESSION=xyz; path=/; ...'
const EXTRA_COOKIE = process.env.COUB_COOKIE || '';

async function fetchJSON(url, retry = 3) {
  for (let attempt = 1; attempt <= retry; attempt++) {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
        ...(EXTRA_COOKIE ? { 'Cookie': EXTRA_COOKIE } : {}),
      },
    }).catch(() => null);

    if (r && r.ok) return r.json();
    if (attempt < retry) await sleep(300 * attempt);
  }
  throw new Error(`Failed to fetch ${url}`);
}

function buildPageUrl(page) {
  const u = new URL(BASE_URL);
  u.searchParams.set('permalink', PERMALINK);
  u.searchParams.set('order_by', ORDER_BY);
  u.searchParams.set('page', String(page));
  // пустой type => весь таймлайн; можно попробовать u.searchParams.set('per_page', PER_PAGE_HINT)
  u.searchParams.set('type', '');
  u.searchParams.set('per_page', String(PER_PAGE_HINT));
  return u.toString();
}

// нормализуем удобные поля для дальнейшей выгрузки видео/аудио
function normalizeCoub(c) {
  return {
    id_numeric: c?.id ?? null,
    permalink: c?.permalink ?? null,                  // ключ для /api/v2/coubs/<permalink>.json
    share_url: c?.permalink ? `https://coub.com/view/${c.permalink}` : null,
    title: c?.title ?? null,
    channel: {
      id: c?.channel?.id ?? null,
      permalink: c?.channel?.permalink ?? null,
      title: c?.channel?.title ?? null,
    },
    created_at: c?.created_at ?? c?.published_at ?? null,
    duration: c?.duration ?? null,
    views_count: c?.views_count ?? null,
    likes_count: c?.likes_count ?? null,
    recoubed: Boolean(c?.recoub || c?.is_recoub || c?.reposted || c?.recouber_id),
    // Не все страницы таймлайна возвращают file_versions — это нормально.
    // Для скачивания медиа используем отдельный вызов api/v2/coubs/<permalink>.json позже.
  };
}

(async () => {
  const collected = [];
  let totalRaw = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildPageUrl(page);
    const data = await fetchJSON(url);

    // Обычно массив в поле `coubs`, но на всякий случай — подстрахуемся.
    const list = Array.isArray(data?.coubs)
      ? data.coubs
      : Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : [];

    if (list.length === 0) {
      console.log(`Page ${page}: empty, stop.`);
      break;
    }

    totalRaw += list.length;

    for (const item of list) {
      collected.push({
        ...normalizeCoub(item),
        _raw: item, // кладём сырой объект про запас (удобно для отладки/доп.полей)
      });
    }

    console.log(`Page ${page}: +${list.length} (total ${collected.length})`);
    await sleep(PAGE_DELAY_MS);
  }

  const outFile = `coub_timeline_${PERMALINK}.json`;
  await writeFile(outFile, JSON.stringify(collected, null, 2), 'utf-8');
  console.log(
    `Saved ${collected.length} items (raw seen: ${totalRaw}) to ${outFile}`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
