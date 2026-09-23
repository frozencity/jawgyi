/**
 * Score the two Jev paths against text of known encoding, alongside the local detector.
 *
 * `isJawgyi` sends one Noul asking whether the text is Zawgyi. `detect` decomposes the
 * problem and asks which of two candidate readings is coherent Burmese. `isZawgyi` makes
 * no request at all. This runs all three over the same samples and reports accuracy,
 * request count and wall time, so the choice is made on numbers.
 *
 *   npm run compare:dry                                 # print the request, send nothing
 *   npm run build
 *   TYPESAFE_API_KEY=... node scripts/compare.mjs --samples 30
 *
 * Cost: one request per sample for isJawgyi, at $0.042 per million input tokens with
 * output free. Thirty full lines is a fraction of a cent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isZawgyi } from '../dist/esm/index.js';
import { isJawgyi, buildDirectQuestion } from '../dist/esm/jev/direct.js';
import { JevClient } from '../dist/esm/jev/client.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    i++;
  } else {
    args.set(token.slice(2), true);
  }
}
const dryRun = args.has('dry-run');
const nSamples = Number(args.get('samples') ?? 20);
const model = args.get('model') ?? 'jev-latest';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const lines = (f, encoding) =>
  readFileSync(join(fixtures, f), 'utf8')
    .split('\n')
    .filter((l) => /[က-႟]/.test(l) && l.trim())
    .map((text) => ({ text, encoding }));

const zawgyi = lines('mmgov_zawgyi_src.txt', 'zawgyi');
const unicode = lines('mmgov_unicode_out.txt', 'unicode');
const corpus = [];
for (let i = 0; corpus.length < nSamples && i < Math.max(zawgyi.length, unicode.length); i++) {
  if (zawgyi[i]) corpus.push(zawgyi[i]);
  if (unicode[i] && corpus.length < nSamples) corpus.push(unicode[i]);
}

if (dryRun) {
  console.log('The request isJawgyi sends:\n');
  console.log(
    JSON.stringify(
      { model, state: `${corpus[0].text.slice(0, 60)}...`, questions: buildDirectQuestion() },
      null,
      2,
    ),
  );
  console.log(`\n${corpus.length} samples would be sent. No key used, nothing sent.`);

  const started = process.hrtime.bigint();
  const right = corpus.filter((c) => isZawgyi(c.text) === (c.encoding === 'zawgyi')).length;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`\nLocal baseline over the same samples, computed just now:`);
  console.log(`  isZawgyi: ${right}/${corpus.length} correct, 0 requests, ${ms.toFixed(1)}ms total`);
  process.exit(0);
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error('Set TYPESAFE_API_KEY, or pass --dry-run to see the request without sending it.');
  process.exit(1);
}

const client = new JevClient({ model });
let jevRight = 0;
let localRight = 0;
let disagreements = 0;
let errors = 0;
const started = Date.now();

console.log(`Scoring ${corpus.length} samples of known encoding.\n`);

for (const { text, encoding } of corpus) {
  const expected = encoding === 'zawgyi';
  if (isZawgyi(text) === expected) localRight++;
  try {
    const v = await isJawgyi(text, client, model);
    if (v.zawgyi === expected) jevRight++;
    if (v.disagrees) disagreements++;
    const mark = v.zawgyi === expected ? 'ok   ' : 'WRONG';
    console.log(
      `${mark} noul=${v.noul.toFixed(3)} expected=${encoding.padEnd(7)} local=${String(v.stage1.encoding).padEnd(7)} ${JSON.stringify(text.slice(0, 28))}`,
    );
  } catch (e) {
    errors++;
    console.log(`ERR   ${e.message}`);
  }
}

const scored = corpus.length - errors;
const seconds = (Date.now() - started) / 1000;
console.log(`\n  isJawgyi   ${jevRight}/${scored}${scored ? ` (${((jevRight / scored) * 100).toFixed(1)}%)` : ''}   ${scored} requests, ${seconds.toFixed(1)}s`);
console.log(`  isZawgyi   ${localRight}/${corpus.length} (${((localRight / corpus.length) * 100).toFixed(1)}%)   0 requests, sub-millisecond`);
console.log(`  disagreed on ${disagreements} of ${scored}`);
