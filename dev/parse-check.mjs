import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n');

const parse = (src) => {
  try { new vm.SourceTextModule(src); return null; } catch (e) { return e.message; }
};

const whole = parse(lines.join('\n'));
console.log('whole file:', whole || 'parses ok');
if (!whole) process.exit(0);

// Grow the prefix one line at a time and stop at the first line where a completed construct
// becomes unparseable in a way the previous line did not show.
let previous = 'ok';
for (let n = 1; n <= lines.length; n++) {
  const message = parse(lines.slice(0, n).join('\n')) || 'ok';
  const truncation = message === 'ok' || /Unexpected end of input|Unexpected end of script/.test(message);
  if (!truncation && previous !== 'ok' && /Unexpected end of input/.test(previous)) {
    console.log('first hard break at line', n, '->', message);
    console.log(lines.slice(Math.max(0, n - 8), n).map((l, i) => `${n - 7 + i}: ${l}`).join('\n'));
    break;
  }
  previous = message;
}
