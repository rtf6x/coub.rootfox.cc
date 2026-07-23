import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const SOURCE_DIR = process.env.SOURCE_DIR || 'src/videos';
const PREFIX = normalizePrefix(process.env.R2_PREFIX || 'coub');
const BUCKET = required('R2_BUCKET');
const ACCOUNT_ID = required('R2_ACCOUNT_ID');
const ACCESS_KEY_ID = required('R2_ACCESS_KEY_ID');
const SECRET_ACCESS_KEY = required('R2_SECRET_ACCESS_KEY');
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

const MIME = {
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
};

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function normalizePrefix(prefix) {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

function objectKey(filename) {
  return `${PREFIX}${filename}`;
}

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      return false;
    }
    throw err;
  }
}

async function uploadFile(filePath, filename) {
  const key = objectKey(filename);
  if (await exists(key)) {
    console.log(`skip ${key}`);
    return { key, status: 'skipped' };
  }

  const body = await readFile(filePath);
  const ext = extname(filename).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  console.log(`upload ${key}`);
  return { key, status: 'uploaded' };
}

async function listFiles(dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const name of entries) {
    const filePath = join(dir, name);
    const info = await stat(filePath);
    if (info.isFile()) files.push({ filePath, name });
  }
  return files;
}

async function runPool(items, worker) {
  let index = 0;
  const results = [];

  async function next() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
  return results;
}

const files = await listFiles(SOURCE_DIR);
if (!files.length) {
  console.log(`No files in ${SOURCE_DIR}`);
  process.exit(0);
}

console.log(`Syncing ${files.length} file(s) to s3://${BUCKET}/${PREFIX}`);

const results = await runPool(files, ({ filePath, name }) => uploadFile(filePath, name));
const uploaded = results.filter((r) => r.status === 'uploaded').length;
const skipped = results.filter((r) => r.status === 'skipped').length;

console.log(`Done. uploaded=${uploaded}, skipped=${skipped}`);
