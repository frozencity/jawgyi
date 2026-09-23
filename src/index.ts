/**
 * jawgyi: Zawgyi vs Unicode detection for Burmese text.
 *
 * Stage 1 is local, free and sub-millisecond, and settles essentially all real text.
 * Stage 2 asks Jev, and only for the samples stage 1 genuinely cannot call.
 */
import { detectSync, shouldEscalate, DEFAULTS } from './detect.ts';
import { resolveWithJev, type JevResolution } from './jev/resolve.ts';
import { zawgyiToUnicode } from './convert.ts';
import type { Detection, DetectOptions, SystemOneClient } from './types.ts';

export { detectSync, shouldEscalate, DEFAULTS } from './detect.ts';
export { zawgyiToUnicode, unicodeToZawgyi, normalizeZawgyi } from './convert.ts';
export { JevClient, TypeSafeError, type ClientOptions } from './jev/client.ts';
export { resolveWithJev, type JevResolution } from './jev/resolve.ts';
export { buildQuestions, buildState, QUESTION_IDS, OPTIONS, THRESHOLDS } from './jev/questions.ts';

/** Single-question encoding classification via Jev. See `isZawgyi` for the local path. */
export { isJawgyi, buildDirectQuestion, DIRECT_QUESTION_ID, type DirectVerdict } from './jev/direct.ts';
export { scanCodepoints, verdictFromCodepoints, type CodepointEvidence } from './codepoints.ts';
export type {
  Detection,
  DetectOptions,
  Encoding,
  Evidence,
  Question,
  Answer,
  SystemOneClient,
  SystemOneRequest,
  SystemOneResponse,
} from './types.ts';

export interface DetectAsyncOptions extends DetectOptions {
  /**
   * Supply a client to enable stage 2. Without one, `detect` behaves exactly like
   * `detectSync` and returns `encoding: null` on samples it cannot call, which is the
   * honest answer, not a failure.
   */
  client?: SystemOneClient;
  /** Model id. Pin a version in production; `jev-latest` can move. */
  model?: string;
  /**
   * What to do if the Jev call throws. 'fallback' keeps stage 1's result and notes the
   * failure; 'throw' propagates. Default 'fallback'. An encoding guess is rarely worth
   * taking down the caller for.
   */
  onError?: 'fallback' | 'throw';
}

/**
 * Detect the encoding, escalating to Jev only when the local evidence is too weak.
 *
 * On text with 15 or more Myanmar characters, measurements on a parallel corpus put
 * escalation at roughly 1.6% of samples, so the common path stays offline and free.
 */
export async function detect(text: string, options: DetectAsyncOptions = {}): Promise<Detection | JevResolution> {
  const stage1 = detectSync(text, options);
  if (!options.client || !shouldEscalate(stage1, options)) return stage1;

  try {
    return await resolveWithJev(text, stage1, options.client, options.model);
  } catch (error) {
    if (options.onError === 'throw') throw error;
    return {
      ...stage1,
      reasons: [...stage1.reasons, `Jev escalation failed: ${(error as Error).message}`],
    };
  }
}

/**
 * Normalise to Unicode, converting only when the text is confidently Zawgyi.
 *
 * Returns the input unchanged when the encoding is unknown. Converting on a guess is how
 * corpora get silently corrupted: a wrong Z2U pass is not reversible by a later U2Z pass.
 */
export async function toUnicode(
  text: string,
  options: DetectAsyncOptions = {},
): Promise<{ text: string; detection: Detection; converted: boolean }> {
  const detection = await detect(text, options);
  const converted = detection.encoding === 'zawgyi';
  return { text: converted ? zawgyiToUnicode(text) : text, detection, converted };
}

/** Convenience for callers that only want a boolean and accept a guess on weak evidence. */
export function isZawgyi(text: string, options: DetectOptions = {}): boolean {
  const d = detectSync(text, options);
  if (d.encoding !== null) return d.encoding === 'zawgyi';
  return (d.probability ?? 0) > 0.5;
}
