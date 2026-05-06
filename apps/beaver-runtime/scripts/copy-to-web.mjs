// Copy the built UMD + CSS into apps/web/public/vendor/ so Next.js serves
// them as /vendor/beaver.umd.js and /vendor/beaver.css to the iframe.

import { mkdir, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const targetDir = resolve(here, '..', '..', 'web', 'public', 'vendor');

const candidates = [
  ['beaver.umd.js', 'beaver.umd.js'],
  ['beaver.css', 'beaver.css'],
  ['style.css', 'beaver.css'],
];

await mkdir(targetDir, { recursive: true });

let copied = 0;
for (const [srcName, destName] of candidates) {
  const src = resolve(distDir, srcName);
  try {
    await access(src);
  } catch {
    continue;
  }
  await copyFile(src, resolve(targetDir, destName));
  copied += 1;
  console.log(`copied ${srcName} -> apps/web/public/vendor/${destName}`);
}

if (copied === 0) {
  console.error(
    `No artifacts found in ${distDir}. Did vite build succeed? ` +
      `Expected one of: ${candidates.map(([s]) => s).join(', ')}.`,
  );
  process.exit(1);
}
