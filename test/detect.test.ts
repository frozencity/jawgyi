import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSync, shouldEscalate, isZawgyi } from '../src/index.ts';
import { zawgyiToUnicode, unicodeToZawgyi } from '../src/convert.ts';
import { scanCodepoints } from '../src/codepoints.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f: string): string => readFileSync(join(fixtures, f), 'utf8');
/** Only lines that actually contain Burmese. The files carry English headers too. */
const burmeseLines = (f: string): string[] =>
  read(f)
    .split('\n')
    .filter((l) => /[က-႟]/.test(l) && l.trim().length > 0);

const UNICODE_DOC = read('udhr_mya_unicode_src.txt');
/** Burmese prose only, long enough that the Markov model is allowed to overrule a code point. */
const UNICODE_PROSE = burmeseLines('udhr_mya_unicode_src.txt').join(' ').slice(0, 400);
const ZAWGYI_DOC = read('udhr_mya_zawgyi_out.txt');

describe('stage 1 on full documents', () => {
  test('classifies a Unicode document', () => {
    const d = detectSync(UNICODE_DOC);
    assert.equal(d.encoding, 'unicode');
    assert.ok(d.confidence > 0.9, `confidence ${d.confidence}`);
  });

  test('classifies a Zawgyi document', () => {
    const d = detectSync(ZAWGYI_DOC);
    assert.equal(d.encoding, 'zawgyi');
    assert.ok(d.confidence > 0.9, `confidence ${d.confidence}`);
  });

  test('neither document needs escalation', () => {
    for (const doc of [UNICODE_DOC, ZAWGYI_DOC]) {
      assert.equal(shouldEscalate(detectSync(doc)), false);
    }
  });
});

describe('stage 1 per line, across both corpora', () => {
  const cases = [
    ['udhr_mya_unicode_src.txt', 'unicode'],
    ['mmgov_unicode_out.txt', 'unicode'],
    ['udhr_mya_zawgyi_out.txt', 'zawgyi'],
    ['mmgov_zawgyi_src.txt', 'zawgyi'],
  ] as const;

  for (const [file, expected] of cases) {
    test(`${file} -> ${expected}, never confidently wrong`, () => {
      const lines = burmeseLines(file);
      assert.ok(lines.length > 20, `expected a real corpus, got ${lines.length} lines`);

      const results = lines.map((l) => ({ line: l, d: detectSync(l) }));
      const other = expected === 'zawgyi' ? 'unicode' : 'zawgyi';

      // The contract is not "always right". It is "never confidently wrong". A caller
      // can recover from `null`; it cannot recover from a confident lie.
      const wrong = results.filter((r) => r.d.encoding === other);
      assert.equal(
        wrong.length,
        0,
        `${wrong.length}/${lines.length} misclassified, first: ${JSON.stringify(wrong[0]?.line.slice(0, 60))}`,
      );

      // Abstentions are legitimate but should stay rare on ordinary prose; if this
      // climbs, the thresholds have drifted and escalation cost will climb with it.
      const abstained = results.filter((r) => r.d.encoding === null);
      assert.ok(
        abstained.length / lines.length < 0.05,
        `abstained on ${abstained.length}/${lines.length} lines`,
      );

      // Whatever stage 1 could not call must be handed to stage 2, not dropped.
      for (const r of abstained) {
        assert.equal(shouldEscalate(r.d), true, `should escalate: ${JSON.stringify(r.line.slice(0, 40))}`);
      }
    });
  }
});

describe('refusing to guess', () => {
  test('returns null for text with no Myanmar characters', () => {
    const d = detectSync('Hello world, this is plain English.');
    assert.equal(d.encoding, null);
    assert.equal(d.evidence, 'no-myanmar');
    assert.equal(d.probability, null);
    assert.equal(shouldEscalate(d), false, 'nothing to ask Jev about');
  });

  test('empty string is not Unicode, it is unknown', () => {
    assert.equal(detectSync('').encoding, null);
  });

  test('Myanmar digits alone carry no signal', () => {
    // U+1040..U+1049 are the Myanmar digits; they sit in the block but the chain
    // has no transitions to score, and upstream would report this as strong Unicode.
    const d = detectSync('၁၂၃');
    assert.equal(d.encoding, null);
    assert.ok(d.myanmarChars > 0);
  });

  test('a very short sample is reported as uncertain, not guessed', () => {
    const short = burmeseLines('udhr_mya_unicode_src.txt')[0]!.replace(/[^က-႟]/g, '').slice(0, 3);
    const d = detectSync(short);
    assert.ok(
      d.encoding === null || d.confidence < 0.95,
      `3 characters should not produce a confident verdict, got ${d.encoding} @ ${d.confidence}`,
    );
  });
});

describe('code-point evidence', () => {
  test('U+103E proves Unicode', () => {
    const e = scanCodepoints('ကှ');
    assert.equal(e.unicodeOnly, 1);
    assert.equal(e.zawgyiOnly, 0);
  });

  test('U+1033 proves Zawgyi', () => {
    const e = scanCodepoints('ကဳ');
    assert.equal(e.zawgyiOnly, 1);
    assert.equal(e.unicodeOnly, 0);
  });

  test('conflicting proof yields no verdict rather than a coin flip', () => {
    const d = detectSync('ကှခဳ');
    assert.equal(d.encoding, null);
  });

  test('an isolated Zawgyi code point in long Unicode text is a conflict, not a verdict', () => {
    // The regression this pins: one stray code point used to return zawgyi at 0.95
    // confidence over a passage the model scored at P(Zawgyi)=0.000000, and toUnicode
    // would then rewrite that whole passage irreversibly.
    const d = detectSync(`${UNICODE_PROSE}ဳ`);
    assert.equal(d.encoding, null);
    assert.equal(d.evidence, 'conflict');
    assert.ok((d.probability ?? 1) < 0.05, 'the model should still read it as Unicode');
    assert.equal(shouldEscalate(d), true, 'a conflict is what the mixed question is for');
    assert.ok(d.reasons.some((r) => r.includes('mixed')));
  });

  test('a lone Zawgyi code point the model contradicts is a conflict', () => {
    // The other route into a conflict: no Unicode-only marker present, so the code-point
    // layer is certain, and the model disagrees over enough text to be trusted.
    const clean = [...UNICODE_PROSE].filter((c) => c !== 'ှ').join('');
    const d = detectSync(`${clean}ဳ`);
    assert.ok(d.myanmarChars >= 15, 'fixture must be long enough to trust the model');
    assert.equal(d.encoding, null);
    assert.equal(d.evidence, 'conflict');
    assert.ok(d.reasons.some((r) => r.includes('says unicode')));
  });

  test('code points still win when the model agrees or cannot be trusted', () => {
    // Agreement: a real Zawgyi document has both signals pointing the same way.
    assert.equal(detectSync(ZAWGYI_DOC).encoding, 'zawgyi');

    // Too short for the model to overrule anything: under 15 Myanmar characters the
    // code point is the better evidence and keeps its verdict.
    const short = detectSync('ကခဳ');
    assert.equal(short.encoding, 'zawgyi');
    assert.equal(short.evidence, 'codepoint');
  });
});

describe('conversion', () => {
  // The fixtures are generated pairs, so each one tests the direction it was made in:
  // mmgov's Zawgyi is the source and its Unicode the Z2U output; udhr is the reverse.
  test('Zawgyi to Unicode matches its reference output exactly', () => {
    const z = burmeseLines('mmgov_zawgyi_src.txt');
    const u = burmeseLines('mmgov_unicode_out.txt');
    assert.equal(z.length, u.length, 'corpora should be line-aligned');
    const wrong = z.map((l, i) => [zawgyiToUnicode(l), u[i]] as const).filter(([a, b]) => a !== b);
    assert.equal(wrong.length, 0, `${wrong.length}/${z.length} lines differ`);
  });

  test('Unicode to Zawgyi matches its reference output', () => {
    const u = burmeseLines('udhr_mya_unicode_src.txt');
    const z = burmeseLines('udhr_mya_zawgyi_out.txt');
    const wrong = u.map((l, i) => [unicodeToZawgyi(l), z[i]] as const).filter(([a, b]) => a !== b);
    assert.ok(wrong.length <= 1, `${wrong.length}/${u.length} lines differ`);
  });

  test('round-tripping through Zawgyi is lossy, which is why toUnicode is one-way', () => {
    // Zawgyi-to-Unicode is many-to-one: several Zawgyi spellings normalise to the same
    // Unicode, so the trip back cannot recover the original. Anyone tempted to store
    // Zawgyi and convert on read should see this fail loudly instead of losing data.
    const z = burmeseLines('mmgov_zawgyi_src.txt');
    const restored = z.filter((l) => unicodeToZawgyi(zawgyiToUnicode(l)) === l);
    assert.ok(restored.length < z.length, 'expected the round trip to lose information');
  });

  test('converted Zawgyi is then detected as Unicode', () => {
    const converted = zawgyiToUnicode(ZAWGYI_DOC);
    assert.equal(detectSync(converted).encoding, 'unicode');
  });

  test('Unicode to Zawgyi is then detected as Zawgyi', () => {
    assert.equal(detectSync(unicodeToZawgyi(UNICODE_DOC)).encoding, 'zawgyi');
  });
});

describe('isZawgyi convenience', () => {
  test('agrees with detectSync on clear documents', () => {
    assert.equal(isZawgyi(ZAWGYI_DOC), true);
    assert.equal(isZawgyi(UNICODE_DOC), false);
  });
});
