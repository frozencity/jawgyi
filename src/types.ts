/** The two encodings that share the Myanmar Unicode block. */
export type Encoding = 'unicode' | 'zawgyi';

/** Which layer produced the verdict. Useful for telemetry and for debugging a wrong answer. */
export type Evidence =
  /** A code point that only ever appears in one of the two encodings. */
  | 'codepoint'
  /** The trained Markov classifier. */
  | 'markov'
  /** The Jev stage resolved an ambiguous case. */
  | 'jev'
  /** Code points and the model disagreed strongly. No verdict; likely mixed or corrupt. */
  | 'conflict'
  /** No Myanmar-range characters at all, nothing to decide. */
  | 'no-myanmar';

export interface Detection {
  /**
   * The encoding, or null when the text cannot be classified: either it contains no
   * Myanmar characters, or the evidence was too weak and no Jev resolver was configured.
   * Callers must handle null; that is the entire point of this library.
   */
  encoding: Encoding | null;
  /** 0..1. Below `uncertainBelow` the caller should treat `encoding` as a guess. */
  confidence: number;
  /** Which layer decided. */
  evidence: Evidence;
  /** Raw P(Zawgyi) from the Markov model, or null when the text carries no signal. */
  probability: number | null;
  /** How many Myanmar-block characters the text contains. Drives escalation. */
  myanmarChars: number;
  /** Whether the Jev stage was consulted. Always false when no resolver is configured. */
  escalated: boolean;
  /** Short human-readable notes on what drove the verdict. */
  reasons: string[];
}

export interface DetectOptions {
  /**
   * Escalate to Jev when the text has fewer than this many Myanmar characters.
   * Default 8: measured on a 308-line parallel corpus, the Markov model is 86% accurate
   * at 6 characters and 97.7% at 8, so 8 is where it stops being a coin flip.
   */
  shortTextThreshold?: number;
  /**
   * Escalate when P(Zawgyi) lands in [lo, hi]. Default [0.05, 0.95], which catches
   * ~1.6% of 15-character samples and 0.3% of full lines, so escalation stays rare
   * and cheap on normal text.
   */
  uncertainBand?: readonly [number, number];
  /** Below this confidence the result is reported as `encoding: null`. Default 0.75. */
  uncertainBelow?: number;
}

/** A question as sent to the TypeSafe evaluation endpoint. */
export type Question =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: readonly unknown[] };

/** An answer as returned by the endpoint. Noul answers carry no confidence field. */
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score';
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Anything that can evaluate a System One request. The built-in HTTP client implements it,
 * and so does a hand-written stub, which is how the Jev stage is tested without a key.
 */
export interface SystemOneClient {
  evaluate(request: SystemOneRequest): Promise<SystemOneResponse>;
}
