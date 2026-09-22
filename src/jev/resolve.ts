import { zawgyiToUnicode } from '../convert.ts';
import type { Detection, SystemOneClient } from '../types.ts';
import { buildQuestions, buildState, OPTIONS, QUESTION_IDS, THRESHOLDS } from './questions.ts';

export interface JevResolution extends Detection {
  /** True when Jev reported that the sample mixes both encodings in one field. */
  mixed: boolean;
  /** Jev's probability that the readable text is Burmese rather than another Myanmar-script language. */
  burmeseProbability: number;
  /** Tokens billed for the escalation, so callers can account for the cost. */
  usage: { input_tokens: number; output_tokens: number } | null;
}

/**
 * Resolve an ambiguous sample by asking Jev which of the two candidate readings is
 * coherent Burmese. All three questions ride in one request: Jev evaluates them in
 * parallel against one ingestion of the state, so the extra two cost only their own
 * tokens and almost no extra latency.
 */
export async function resolveWithJev(
  text: string,
  stage1: Detection,
  client: SystemOneClient,
  model = 'jev-latest',
): Promise<JevResolution> {
  const readings = { asWritten: text, ifConverted: zawgyiToUnicode(text) };

  // Z2U is close to a no-op on text that is already Unicode. With nothing to tell apart,
  // the Choice is a coin flip, so spend nothing and keep stage 1's answer.
  if (readings.asWritten === readings.ifConverted) {
    return {
      ...stage1,
      escalated: false,
      mixed: false,
      burmeseProbability: NaN,
      usage: null,
      reasons: [...stage1.reasons, 'conversion is a no-op; both readings identical'],
    };
  }

  const response = await client.evaluate({
    model,
    state: buildState(readings),
    questions: buildQuestions(),
  });

  const reading = response.answers[QUESTION_IDS.reading];
  const isBurmese = response.answers[QUESTION_IDS.isBurmese];
  const isMixed = response.answers[QUESTION_IDS.isMixed];

  if (reading?.type !== 'choice') {
    throw new Error(`Expected a choice answer for ${QUESTION_IDS.reading}, got ${reading?.type}`);
  }

  const burmeseProbability = isBurmese?.type === 'noul' ? isBurmese.noul : NaN;
  const mixed = isMixed?.type === 'noul' && isMixed.noul > THRESHOLDS.mixedProbability;
  const reasons: string[] = [
    `Jev chose ${reading.choice} at confidence ${reading.confidence.toFixed(2)}`,
  ];

  const abstain = (reason: string): JevResolution => {
    reasons.push(reason);
    return {
      ...stage1,
      encoding: null,
      confidence: 0,
      evidence: 'jev',
      escalated: true,
      mixed,
      burmeseProbability,
      usage: response.usage,
      reasons,
    };
  };

  if (mixed) return abstain('Jev reports mixed encodings; split the document and detect per span');
  if (reading.choice === OPTIONS.neither) return abstain('Jev found no readable Burmese in either reading');
  if (reading.confidence < THRESHOLDS.readingConfidence) {
    return abstain(`confidence below ${THRESHOLDS.readingConfidence}`);
  }
  if (Number.isFinite(burmeseProbability) && burmeseProbability < THRESHOLDS.burmeseProbability) {
    return abstain(
      `P(Burmese)=${burmeseProbability.toFixed(2)}; Myanmar-script but likely another language, ` +
        'where the code-point heuristics do not hold',
    );
  }

  // reading_a readable means the text was already fine, so it was Unicode.
  // reading_b readable means conversion repaired it, so it was Zawgyi.
  const encoding = reading.choice === OPTIONS.asWritten ? 'unicode' : 'zawgyi';

  return {
    ...stage1,
    encoding,
    confidence: reading.confidence,
    evidence: 'jev',
    escalated: true,
    mixed: false,
    burmeseProbability,
    usage: response.usage,
    reasons,
  };
}
