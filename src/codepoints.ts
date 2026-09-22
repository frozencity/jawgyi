/**
 * Code-point evidence: the cases where the encoding is decidable without statistics.
 *
 * Every constant here was measured against a 308-line parallel corpus (UDHR Burmese plus
 * Myanmar government text, same content in both encodings) rather than recalled from a
 * spec. `scripts/derive-codepoints.mjs` regenerates the counts.
 */

const MM_LO = 0x1000;
const MM_HI = 0x109f;

/**
 * Code points that appear in the Zawgyi corpus and never in the Unicode one.
 *
 * Caveat that matters: in Unicode these are legitimately assigned to Mon, Shan, Karen and
 * Palaung. They mean "Zawgyi" only for *Burmese* text. Shan Unicode text will trip them,
 * which is exactly why `isBurmese` exists in the Jev stage.
 */
const ZAWGYI_ONLY = new Set([
  0x1033, 0x1034, 0x105a, 0x1061, 0x1062, 0x1065, 0x106b, 0x1072, 0x1075, 0x1078, 0x107d,
  0x107e, 0x107f, 0x1080, 0x1087, 0x1088, 0x108a, 0x108f, 0x1090, 0x1093, 0x1094, 0x1095,
]);

/**
 * U+103E MYANMAR CONSONANT SIGN MEDIAL HA: 419 occurrences in the Unicode corpus, zero in
 * the Zawgyi one. Zawgyi shifts its medials down a slot, so it never produces this.
 * The single cleanest marker in either direction.
 */
const UNICODE_ONLY = new Set([0x103e]);

const isConsonant = (cp: number): boolean => cp >= 0x1000 && cp <= 0x1021;

export interface CodepointEvidence {
  /** Count of Myanmar-block characters. */
  myanmarChars: number;
  /** Hits on code points exclusive to Zawgyi. */
  zawgyiOnly: number;
  /** Hits on code points exclusive to Unicode. */
  unicodeOnly: number;
  /** U+1031 stored before its consonant (Zawgyi keeps visual order). */
  visualOrder: number;
  /** U+1031 stored after its consonant (Unicode keeps logical order). */
  logicalOrder: number;
  /** U+1039, used as the stacking virama in Unicode but as asat in Zawgyi (32x skew). */
  virama: number;
  /** U+103A, the Unicode asat (8x skew toward Unicode). */
  asat: number;
}

export function scanCodepoints(text: string): CodepointEvidence {
  const e: CodepointEvidence = {
    myanmarChars: 0,
    zawgyiOnly: 0,
    unicodeOnly: 0,
    visualOrder: 0,
    logicalOrder: 0,
    virama: 0,
    asat: 0,
  };
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp < MM_LO || cp > MM_HI) continue;
    e.myanmarChars++;
    if (ZAWGYI_ONLY.has(cp)) e.zawgyiOnly++;
    else if (UNICODE_ONLY.has(cp)) e.unicodeOnly++;
    else if (cp === 0x1039) e.virama++;
    else if (cp === 0x103a) e.asat++;
    else if (cp === 0x1031) {
      // U+1031 occurs with identical frequency in both encodings (938 vs 938 in the
      // corpus). Only its position differs, so position is the whole signal.
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (isConsonant(next)) e.visualOrder++;
      else if (isConsonant(prev)) e.logicalOrder++;
    }
  }
  return e;
}

export interface CodepointVerdict {
  encoding: 'unicode' | 'zawgyi' | null;
  confidence: number;
  reasons: string[];
}

/**
 * Decide from code points alone, or return null to defer to the Markov model.
 *
 * Only the exclusive sets are treated as decisive. The ordering and virama counts are
 * real signal but they overlap between encodings, so they stay advisory. The Markov
 * model already weighs that kind of distributional evidence better than a threshold can.
 */
export function verdictFromCodepoints(e: CodepointEvidence): CodepointVerdict {
  const reasons: string[] = [];

  // A single exclusive code point is decisive; two or more make a corrupted-text
  // explanation implausible, so confidence goes higher.
  if (e.zawgyiOnly > 0 && e.unicodeOnly === 0) {
    reasons.push(`${e.zawgyiOnly} Zawgyi-exclusive code point(s)`);
    return { encoding: 'zawgyi', confidence: e.zawgyiOnly >= 2 ? 0.99 : 0.95, reasons };
  }
  if (e.unicodeOnly > 0 && e.zawgyiOnly === 0) {
    reasons.push(`${e.unicodeOnly} occurrence(s) of U+103E (Unicode-only medial ha)`);
    return { encoding: 'unicode', confidence: e.unicodeOnly >= 2 ? 0.99 : 0.95, reasons };
  }
  // Both fired: the text is probably mixed, or not Burmese. Refuse to guess.
  if (e.zawgyiOnly > 0 && e.unicodeOnly > 0) {
    reasons.push(
      `conflicting evidence: ${e.zawgyiOnly} Zawgyi-only and ${e.unicodeOnly} Unicode-only code points`,
    );
    return { encoding: null, confidence: 0, reasons };
  }
  return { encoding: null, confidence: 0, reasons };
}
