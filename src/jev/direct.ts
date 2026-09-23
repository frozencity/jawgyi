/**
 * Single-question encoding classification via Jev.
 *
 * `detect` decomposes the problem: code produces both candidate readings and Jev is asked
 * which one is coherent Burmese. This module takes the direct route instead. It sends the
 * text as state and asks one Noul, "is this Zawgyi", and returns the probability.
 *
 * Worth knowing before you pick between them. Jev receives decoded code points in a JSON
 * body, not bytes, so the source encoding is not present in what it evaluates. The answer
 * is therefore inferred from the shape of the text rather than observed. `detect` is built
 * around that constraint; this function works within it differently.
 *
 * `scripts/compare.mjs` scores both against text of known encoding, alongside the local
 * detector. Run it before choosing.
 */
import { detectSync } from '../detect.ts';
import type { Detection, Question, SystemOneClient } from '../types.ts';

export const DIRECT_QUESTION_ID = 'is_it_zawgyi';

/** The question as sent, exported so it can be reviewed alongside the ones in questions.ts. */
export function buildDirectQuestion(): Record<string, Question> {
  return {
    [DIRECT_QUESTION_ID]: {
      type: 'noul',
      instructions: 'Is this text encoded in the Zawgyi font encoding rather than Unicode?',
      criteria: {
        true: 'The text is Zawgyi encoded.',
        false: 'The text is Unicode encoded.',
      },
    },
  };
}

export interface DirectVerdict {
  /** The probability thresholded at 0.5. */
  zawgyi: boolean;
  /** The raw Noul, between 0 and 1. */
  noul: number;
  /** What the local detector returned for the same text, for comparison. */
  stage1: Detection;
  /** True when the two reached different verdicts. A local `null` does not count. */
  disagrees: boolean;
  /** Restates the constraint above, so it travels with the result. */
  note: string;
}

const NOTE =
  'Jev evaluates decoded code points, not bytes, so the source encoding is inferred ' +
  'rather than observed. isZawgyi decides locally from the same text without a request.';

/**
 * Classify the encoding with one Jev request.
 *
 * Returns an object rather than a boolean. An async function returning a boolean invites
 * `if (isJawgyi(x))`, which is always truthy because a Promise is always truthy, and it
 * would also let this be swapped for the synchronous `isZawgyi` without a type error.
 */
export async function isJawgyi(
  text: string,
  client: SystemOneClient,
  model = 'jev-latest',
): Promise<DirectVerdict> {
  const stage1 = detectSync(text);
  const response = await client.evaluate({
    model,
    state: text,
    questions: buildDirectQuestion(),
  });

  const answer = response.answers[DIRECT_QUESTION_ID];
  if (answer?.type !== 'noul') {
    throw new Error(`Expected a noul answer for ${DIRECT_QUESTION_ID}, got ${answer?.type}`);
  }

  const zawgyi = answer.noul > 0.5;
  return {
    zawgyi,
    noul: answer.noul,
    stage1,
    // A local null is an abstention, not a competing verdict, so it is not a disagreement.
    disagrees: stage1.encoding !== null && stage1.encoding !== (zawgyi ? 'zawgyi' : 'unicode'),
    note: NOTE,
  };
}
