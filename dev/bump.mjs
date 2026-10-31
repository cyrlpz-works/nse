// One version string, written everywhere a browser looks it up, so a deploy cannot ship new files
// under an old query. Run it before every push that touches dist/.
//   node dev/bump.mjs 2026-11-01-1
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}-\d+$/.test(String(version))) {
  console.error('usage: node dev/bump.mjs 2026-11-01-1');
  process.exit(1);
}

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const targets = [
  ['index.html', /(styles\.css\?v=)[^"']+/g],
  ['index.html', /(app\.js\?v=)[^"']+/g],
  ['index.html', /(api\.js\?v=)[^"']+/g],
  ['app.js', /(from '\.\/api\.js\?v=)[^']+/g],
];

for (const [file, pattern] of targets) {
  const path = join(dist, file);
  const before = readFileSync(path, 'utf8');
  if (!pattern.test(before)) {
    console.error(`${file}: nothing matched ${pattern} -- the link moved?`);
    process.exit(1);
  }
  pattern.lastIndex = 0;
  writeFileSync(path, before.replace(pattern, `$1${version}`));
}

writeFileSync(join(dist, 'version.json'), `${JSON.stringify({ build: version })}\n`);
console.log(`dist/ now asks for ${version}`);
