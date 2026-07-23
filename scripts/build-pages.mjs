import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'src';
const DIST = 'dist';
const EXCLUDE = new Set(['videos']);

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await cp(srcPath, destPath);
    }
  }
}

await copyDir(SRC, DIST);
console.log(`Built ${DIST}/ (excluded ${[...EXCLUDE].join(', ')}/)`);
