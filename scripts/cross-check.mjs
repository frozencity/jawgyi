/**
 * Verify the TypeScript and Python implementations agree, line by line, on the corpus.
 *
 * The two share the trained model and the transliteration rules as data, but the
 * detection policy is written twice. This is what catches the two copies drifting.
 *
 *   node scripts/cross-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSync } from '../dist/esm/detect.js';
import { zawgyiToUnicode } from '../dist/esm/convert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'test', 'fixtures');

const lines = [];
for (const f of readdirSync(fixtures)) {
  for (const l of readFileSync(join(fixtures, f), 'utf8').split('\n')) {
    if (/[က-႟]/.test(l) && l.trim()) lines.push(l);
  }
}
// Include truncations, because short text is where the two policies could disagree.
for (const n of [3, 5, 8, 15]) {
  for (const l of lines.slice(0, 40)) {
    const s = [...l].filter((c) => /[က-႟]/.test(c)).slice(0, n).join('');
    if (s) lines.push(s);
  }
}

// Splice a Zawgyi-only code point into Unicode prose and vice versa, at lengths that
// straddle every threshold. The first version of this only produced samples longer than
// 40 Myanmar characters, which meant CONFLICT_MIN_CHARS could be changed from 15 to 40
// in one implementation and this script reported zero disagreements. A safety net that
// never spans the boundary is not a safety net.
const LENGTHS = [1, 2, 3, 5, 7, 8, 9, 13, 14, 15, 16, 17, 20, 25, 30, 39, 40, 41, 60, 120];
const prose = lines.filter((l) => (l.match(/[\u1000-\u109F]/g) ?? []).length > 120).slice(0, 8);

for (const l of prose) {
  const mm = [...l].filter((c) => /[\u1000-\u109F]/.test(c));
  const noHa = mm.filter((c) => c !== '\u103E');
  for (const n of LENGTHS) {
    if (n > noHa.length) continue;
    // A lone Zawgyi-only marker in text the model reads as Unicode: conflicts only once
    // the text is long enough for the model to be trusted.
    lines.push(noHa.slice(0, n).join('') + '\u1033');
    // Both exclusive sets present: conflicts at every length.
    lines.push(noHa.slice(0, n).join('') + '\u103E\u1033');
    // Neither set present: pure model territory, spanning the short-text threshold.
    lines.push(noHa.slice(0, n).join(''));
  }
}

// Finding 2 slipped through because this only ever compared default thresholds.
// The band entries matter more than they look. The Markov model's output is bimodal, so
// nothing the corpus produces ever lands between 0.04 and 0.05, and a divergence in the
// default band is invisible. Moving the band somewhere reachable exercises the same
// comparison code, which is the part that can actually be written wrong.
const PROFILES = [
  {},
  { uncertainBelow: 0.3 },
  { uncertainBelow: 0.95 },
  { shortTextThreshold: 20 },
  { conflictMinChars: 3 },
  { conflictMinChars: 9999 },
  { uncertainBand: [0.3, 0.7] },
  { uncertainBand: [0.45, 0.55] },
];

const tsOut = lines.map((l) => ({
  z2u: zawgyiToUnicode(l),
  profiles: PROFILES.map((o) => {
    const d = detectSync(l, o);
    // reasons are user-facing output, so a divergence there is a contract divergence.
    // It also catches logic that only shows up in the explanation, such as the band
    // comparison, which changes no verdict but does change what we tell the caller.
    return {
      encoding: d.encoding,
      evidence: d.evidence,
      confidence: +d.confidence.toFixed(9),
      reasons: d.reasons,
    };
  }),
}));

const payload = join(root, 'shared', 'cross-check-input.json');
writeFileSync(payload, JSON.stringify(lines));

const py = `
import json, sys
from jawgyi import detect_sync, zawgyi_to_unicode
PROFILES = [
    {},
    {"uncertain_below": 0.3},
    {"uncertain_below": 0.95},
    {"short_text_threshold": 20},
    {"conflict_min_chars": 3},
    {"conflict_min_chars": 9999},
    {"uncertain_band": (0.3, 0.7)},
    {"uncertain_band": (0.45, 0.55)},
]
lines = json.load(open(${JSON.stringify(payload)}))
out = []
for l in lines:
    profiles = []
    for o in PROFILES:
        d = detect_sync(l, **o)
        profiles.append({"encoding": d.encoding, "evidence": d.evidence,
                         "confidence": round(d.confidence, 9),
                         "reasons": list(d.reasons)})
    out.append({"z2u": zawgyi_to_unicode(l), "profiles": profiles})
json.dump(out, sys.stdout)
`;
const pyOut = JSON.parse(
  execFileSync(join(root, 'python', '.venv', 'bin', 'python'), ['-c', py], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

let encodingDiff = 0;
let evidenceDiff = 0;
let confidenceDiff = 0;
let convertDiff = 0;
let reasonDiff = 0;
let comparisons = 0;
for (let i = 0; i < lines.length; i++) {
  for (let p = 0; p < PROFILES.length; p++) {
    const a = tsOut[i].profiles[p];
    const b = pyOut[i].profiles[p];
    comparisons++;
    if (a.encoding !== b.encoding) {
      if (encodingDiff < 3) {
        console.log(`encoding differs (profile ${p}): ${JSON.stringify(lines[i].slice(0, 30))} ts=${a.encoding} py=${b.encoding}`);
      }
      encodingDiff++;
    }
    if (a.evidence !== b.evidence) {
      if (evidenceDiff < 3) {
        console.log(`evidence differs (profile ${p}): ${JSON.stringify(lines[i].slice(0, 30))} ts=${a.evidence} py=${b.evidence}`);
      }
      evidenceDiff++;
    }
    if (Math.abs(a.confidence - b.confidence) > 1e-6) confidenceDiff++;
    if (JSON.stringify(a.reasons) !== JSON.stringify(b.reasons)) {
      if (reasonDiff < 3) {
        console.log(`reasons differ (profile ${p}): ts=${JSON.stringify(a.reasons)} py=${JSON.stringify(b.reasons)}`);
      }
      reasonDiff++;
    }
  }
  if (tsOut[i].z2u !== pyOut[i].z2u) {
    if (convertDiff < 3) console.log(`z2u differs: ${JSON.stringify(lines[i].slice(0, 30))}`);
    convertDiff++;
  }
}

console.log(`\n${lines.length} samples x ${PROFILES.length} threshold profiles = ${comparisons} comparisons`);
console.log(`  encoding disagreements:   ${encodingDiff}`);
console.log(`  evidence disagreements:   ${evidenceDiff}`);
console.log(`  confidence disagreements: ${confidenceDiff}`);
console.log(`  reason disagreements:     ${reasonDiff}`);
console.log(`  conversion disagreements: ${convertDiff}`);
process.exit(encodingDiff + evidenceDiff + confidenceDiff + reasonDiff + convertDiff === 0 ? 0 : 1);
