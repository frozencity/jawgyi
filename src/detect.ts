import { markovZawgyiProbability } from './vendor/markov.ts';
import { scanCodepoints, verdictFromCodepoints } from './codepoints.ts';
import type { Detection, DetectOptions } from './types.ts';

export const DEFAULTS = {
  shortTextThreshold: 8,
  uncertainBand: [0.05, 0.95] as const,
  uncertainBelow: 0.75,
  /**
   * Below this many Myanmar characters the Markov model is not trusted to contradict a
   * code point. Measured: 99.7% accurate at 15 characters, 86% at 6. Under 15 an
   * exclusive code point is the better evidence and wins outright.
   */
  conflictMinChars: 15,
};

/**
 * Local detection. No network, no key, sub-millisecond, works in any runtime.
 *
 * Code points are checked first, because an exclusive code point is proof and the Markov
 * model is only ever evidence.
 *
 * With one exception, which matters. A single Zawgyi-only code point sitting in a long
 * passage the model reads as overwhelmingly Unicode is not proof that the passage is
 * Zawgyi. It is proof that something is wrong with that passage. Those are different
 * claims, and treating the first as the second lets `toUnicode` irreversibly rewrite a
 * whole document because of one character. So a strong disagreement between the two
 * layers produces no verdict at all, and escalates.
 */
export function detectSync(text: string, options: DetectOptions = {}): Detection {
  const opts = { ...DEFAULTS, ...options };
  const cp = scanCodepoints(text);

  if (cp.myanmarChars === 0) {
    return {
      encoding: null,
      confidence: 0,
      evidence: 'no-myanmar',
      probability: null,
      myanmarChars: 0,
      escalated: false,
      reasons: ['no Myanmar-block characters'],
    };
  }

  const verdict = verdictFromCodepoints(cp);
  const probability = markovZawgyiProbability(text);

  // Both exclusive sets fired. Whatever this text is, it is not uniformly one encoding,
  // and handing it to the model would bury that under a confident single answer.
  if (cp.zawgyiOnly > 0 && cp.unicodeOnly > 0) {
    return {
      encoding: null,
      confidence: 0,
      evidence: 'conflict',
      probability,
      myanmarChars: cp.myanmarChars,
      escalated: false,
      reasons: [
        ...verdict.reasons,
        'likely mixed encodings or corrupt text; detect per span rather than converting the whole thing',
      ],
    };
  }

  if (verdict.encoding !== null) {
    const [lo, hi] = opts.uncertainBand;
    const modelIsTrustworthy = cp.myanmarChars >= opts.conflictMinChars;
    const modelIsConfident = probability !== null && (probability <= lo || probability >= hi);
    const modelSays = probability !== null && probability > 0.5 ? 'zawgyi' : 'unicode';

    if (modelIsTrustworthy && modelIsConfident && modelSays !== verdict.encoding) {
      return {
        encoding: null,
        confidence: 0,
        evidence: 'conflict',
        probability,
        myanmarChars: cp.myanmarChars,
        escalated: false,
        reasons: [
          ...verdict.reasons,
          `but P(Zawgyi)=${probability!.toFixed(3)} over ${cp.myanmarChars} Myanmar characters says ${modelSays}`,
          'likely mixed encodings or corrupt text; detect per span rather than converting the whole thing',
        ],
      };
    }

    return {
      encoding: verdict.encoding,
      confidence: verdict.confidence,
      evidence: 'codepoint',
      probability,
      myanmarChars: cp.myanmarChars,
      escalated: false,
      reasons: verdict.reasons,
    };
  }

  const reasons = [...verdict.reasons];

  // Reachable when the text is all Myanmar digits or punctuation: they occupy the block
  // but carry no state transitions, so the chain sees nothing to score.
  if (probability === null) {
    reasons.push('Myanmar characters present but no scoreable transitions');
    return {
      encoding: null,
      confidence: 0,
      evidence: 'no-myanmar',
      probability: null,
      myanmarChars: cp.myanmarChars,
      escalated: false,
      reasons,
    };
  }

  const [lo, hi] = opts.uncertainBand;
  const inBand = probability > lo && probability < hi;
  const tooShort = cp.myanmarChars < opts.shortTextThreshold;

  // Map P(Zawgyi) onto a confidence that is symmetric about 0.5, then discount short
  // text: at 6 Myanmar characters the model is 86% accurate but still reports extreme
  // probabilities, so an undiscounted confidence would be a lie.
  const distance = Math.abs(probability - 0.5) * 2;
  const lengthPenalty = tooShort ? Math.max(0.35, cp.myanmarChars / opts.shortTextThreshold) : 1;
  const confidence = distance * lengthPenalty;

  if (tooShort) reasons.push(`only ${cp.myanmarChars} Myanmar characters`);
  if (inBand) reasons.push(`P(Zawgyi)=${probability.toFixed(3)} is inconclusive`);
  if (!tooShort && !inBand) reasons.push(`P(Zawgyi)=${probability.toFixed(3)}`);

  return {
    encoding: confidence >= opts.uncertainBelow ? (probability > 0.5 ? 'zawgyi' : 'unicode') : null,
    confidence,
    evidence: 'markov',
    probability,
    myanmarChars: cp.myanmarChars,
    escalated: false,
    reasons,
  };
}

/** Whether stage 1's result is weak enough to be worth a Jev call. */
export function shouldEscalate(d: Detection, options: DetectOptions = {}): boolean {
  const opts = { ...DEFAULTS, ...options };
  // Nothing to escalate: no Myanmar content means no question to ask, and a code-point
  // proof is already better than anything a semantic model could tell us. A conflict is
  // the opposite case: it is exactly what the is_mixed_encoding question exists for.
  if (d.evidence === 'no-myanmar') return false;
  if (d.evidence === 'conflict') return true;
  if (d.evidence === 'codepoint' && d.encoding !== null) return false;
  return d.encoding === null || d.confidence < opts.uncertainBelow;
}
