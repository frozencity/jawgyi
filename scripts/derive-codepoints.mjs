/**
 * Re-derive the code-point tables in src/codepoints.ts from the parallel corpus.
 *
 * The tables are measured, not recalled from a spec, so this script is how you check
 * them or extend them with your own corpus. It prints what src/codepoints.ts should
 * contain; it does not edit the file, because the Mon/Shan caveat on the Zawgyi set
 * needs a human to think about before it changes.
 *
 *   node scripts/derive-codepoints.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const read = (f) => readFileSync(join(fixtures, f), 'utf8');
const files = readdirSync(fixtures);

const unicode = files.filter((f) => f.includes('unicode')).map(read).join('');
const zawgyi = files.filter((f) => f.includes('zawgyi')).map(read).join('');
if (!unicode || !zawgyi) throw new Error('Expected both unicode and zawgyi fixtures.');

const tally = (s) => {
  const m = new Map();
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x1000 && c <= 0x109f) m.set(c, (m.get(c) ?? 0) + 1);
  }
  return m;
};

const cu = tally(unicode);
const cz = tally(zawgyi);
const all = [...new Set([...cu.keys(), ...cz.keys()])].sort((a, b) => a - b);
const hex = (c) => `0x${c.toString(16).padStart(4, '0')}`;

// A handful of occurrences is enough to be meaningful but low enough to catch rare marks.
const MIN = 3;
const zOnly = all.filter((c) => !cu.has(c) && (cz.get(c) ?? 0) >= MIN);
const uOnly = all.filter((c) => !cz.has(c) && (cu.get(c) ?? 0) >= MIN);

console.log(`corpus: ${unicode.length} Unicode chars, ${zawgyi.length} Zawgyi chars\n`);
console.log(`ZAWGYI_ONLY (${zOnly.length} code points, >=${MIN} hits, absent from Unicode):`);
console.log(`  ${zOnly.map(hex).join(', ')}\n`);
console.log(`UNICODE_ONLY (${uOnly.length} code points):`);
console.log(`  ${uOnly.map(hex).join(', ')}\n`);

console.log('Skewed but shared (kept advisory, not decisive):');
for (const c of all) {
  const u = cu.get(c) ?? 0;
  const z = cz.get(c) ?? 0;
  if (u && z && u + z >= 20) {
    const ratio = z / u;
    if (ratio >= 8 || ratio <= 1 / 8) {
      console.log(`  ${hex(c)}  unicode=${u} zawgyi=${z}  z/u=${ratio.toFixed(1)}`);
    }
  }
}

const pos = (s, sign) => {
  let n = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    const [vowel, cons] = sign === 'pre' ? [a, b] : [b, a];
    if (vowel === 0x1031 && cons >= 0x1000 && cons <= 0x1021) n++;
  }
  return n;
};
console.log('\nU+1031 ordering (identical frequency in both, so only position carries signal):');
console.log(`  before consonant (visual/Zawgyi):  unicode=${pos(unicode, 'pre')} zawgyi=${pos(zawgyi, 'pre')}`);
console.log(`  after  consonant (logical/Unicode): unicode=${pos(unicode, 'post')} zawgyi=${pos(zawgyi, 'post')}`);
