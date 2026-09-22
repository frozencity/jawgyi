/**
 * Measure the Jev stage against a corpus of known-encoding samples.
 *
 * This exists because the one thing nobody can tell you from the docs is how well
 * jev-1.13 reads Burmese. Burmese is a low-resource language; the questions in
 * src/jev/questions.ts are written carefully, but "carefully written" is a hypothesis
 * until it is measured. Run this before trusting stage 2 in production, and re-run it
 * whenever you change a question, a threshold, or the pinned model version.
 *
 *   node scripts/calibrate.mjs --dry-run          # print one request, send nothing
 *   node scripts/calibrate.mjs --samples 40       # needs TYPESAFE_API_KEY
 *   node scripts/calibrate.mjs --chars 3 --model jev-1.13.0
 *
 * Cost: one request per sample. At the published $0.042/Mtok input with output free,
 * a 40-sample run is well under a cent, but it is real money and a real API, so the
 * script tells you what it is about to spend and requires an explicit key.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSync } from '../dist/esm/detect.js';
import { zawgyiToUnicode } from '../dist/esm/convert.js';
import { JevClient } from '../dist/esm/jev/client.js';
import { resolveWithJev } from '../dist/esm/jev/resolve.js';
import { buildQuestions, buildState } from '../dist/esm/jev/questions.js';

// Walk one argument at a time. Stepping in pairs silently drops a valued flag whenever
// a boolean flag precedes it, which made `--dry-run --samples 40` ignore the sample count.
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const name = token.slice(2);
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    args.set(name, next);
    i++;
  } else {
    args.set(name, true);
  }
}
const dryRun = args.has('dry-run');
const nSamples = Number(args.get('samples') ?? 20);
const nChars = Number(args.get('chars') ?? 4);
const model = args.get('model') ?? 'jev-latest';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const read = (f) => readFileSync(join(fixtures, f), 'utf8');

/** Cut a corpus into short spans, the regime where stage 1 measurably struggles. */
function samples(file, encoding, count) {
  const chars = [...read(file)].filter((c) => /[က-႟ ]/.test(c));
  const out = [];
  for (let i = 0; out.length < count && i + nChars < chars.length; i += 13) {
    const text = chars.slice(i, i + nChars).join('').trim();
    if ((text.match(/[က-႟]/g) ?? []).length < nChars) continue;
    if (zawgyiToUnicode(text) === text) continue; // nothing for Jev to compare
    out.push({ text, encoding });
  }
  return out;
}

const corpus = [
  ...samples('mmgov_zawgyi_src.txt', 'zawgyi', Math.ceil(nSamples / 2)),
  ...samples('mmgov_unicode_out.txt', 'unicode', Math.floor(nSamples / 2)),
];

if (dryRun) {
  const { text } = corpus[0];
  console.log('Sample request for:', JSON.stringify(text));
  console.log(
    JSON.stringify({ model, state: buildState({ asWritten: text, ifConverted: zawgyiToUnicode(text) }), questions: buildQuestions() }, null, 2),
  );
  console.log(`\n${corpus.length} samples would be sent. No key used, nothing sent.`);
  process.exit(0);
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error('Set TYPESAFE_API_KEY, or pass --dry-run to inspect the request without sending.');
  process.exit(1);
}

console.log(`Calibrating ${model} on ${corpus.length} samples of ${nChars} Myanmar characters.\n`);
const client = new JevClient({ model });

let stage1Right = 0;
let jevRight = 0;
let jevWrong = 0;
let jevAbstained = 0;
let jevErrored = 0;
let escalations = 0;
let inputTokens = 0;

for (const { text, encoding } of corpus) {
  const stage1 = detectSync(text);
  if (stage1.encoding === encoding) stage1Right++;
  if (stage1.encoding !== null) continue;

  escalations++;
  try {
    const r = await resolveWithJev(text, stage1, client, model);
    inputTokens += r.usage?.input_tokens ?? 0;
    if (r.encoding === null) jevAbstained++;
    else if (r.encoding === encoding) jevRight++;
    else jevWrong++;
    const mark = r.encoding === null ? '-' : r.encoding === encoding ? 'ok' : 'WRONG';
    console.log(
      `${mark.padEnd(5)} ${JSON.stringify(text).padEnd(14)} expected ${encoding.padEnd(7)} got ${String(r.encoding).padEnd(7)} conf ${r.confidence.toFixed(2)}`,
    );
  } catch (e) {
    jevErrored++;
    console.log(`ERR   ${JSON.stringify(text)}: ${e.message}`);
  }
}

// Only samples Jev actually returned a verdict for. Counting errors here would quietly
// inflate the accuracy figure, which is the one number this script exists to report.
const decided = jevRight + jevWrong;
console.log(`\nstage 1 alone:      ${stage1Right}/${corpus.length} correct`);
console.log(`escalated:          ${escalations}`);
console.log(`  Jev decided:      ${decided}${decided ? ` (${((jevRight / decided) * 100).toFixed(1)}% correct)` : ''}`);
console.log(`  Jev abstained:    ${jevAbstained}`);
console.log(`  errored:          ${jevErrored}`);
console.log(`combined correct:   ${stage1Right + jevRight}/${corpus.length}`);
console.log(`input tokens:       ${inputTokens} (~$${((inputTokens / 1e6) * 0.042).toFixed(5)} at $0.042/Mtok)`);
console.log('\nIf "Jev decided" is small or its accuracy is near chance, stage 2 is not earning');
console.log('its keep on this corpus. Ship stage 1 alone rather than paying for noise.');
