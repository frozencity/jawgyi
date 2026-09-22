import type { Answer, SystemOneClient, SystemOneRequest, SystemOneResponse } from '../src/types.ts';
import { OPTIONS, QUESTION_IDS } from '../src/jev/questions.ts';

export interface StubOptions {
  choice?: string;
  choiceConfidence?: number;
  burmese?: number;
  mixed?: number;
}

/**
 * A SystemOneClient that returns shaped answers without a network call.
 *
 * Every response it produces matches the documented answer schema exactly, including
 * the detail that Noul answers carry no `confidence` field, only Choice and Score do.
 * If that ever drifts from the real API, these tests are where it should surface.
 */
export class StubClient implements SystemOneClient {
  readonly requests: SystemOneRequest[] = [];
  private readonly options: StubOptions;

  constructor(options: StubOptions = {}) {
    this.options = options;
  }

  async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
    this.requests.push(request);
    const {
      choice = OPTIONS.asWritten,
      choiceConfidence = 0.95,
      burmese = 0.98,
      mixed = 0.01,
    } = this.options;

    const others = [OPTIONS.asWritten, OPTIONS.ifConverted, OPTIONS.neither].filter((o) => o !== choice);
    const rest = (1 - choiceConfidence) / others.length;
    const probabilities: Record<string, number> = { [choice]: choiceConfidence };
    for (const o of others) probabilities[o] = rest;

    const answers: Record<string, Answer> = {
      [QUESTION_IDS.reading]: { type: 'choice', choice, probabilities, confidence: choiceConfidence },
      [QUESTION_IDS.isBurmese]: { type: 'noul', noul: burmese },
      [QUESTION_IDS.isMixed]: { type: 'noul', noul: mixed },
    };

    return { model: 'jev-1.13.0', answers, usage: { input_tokens: 412, output_tokens: 61 } };
  }
}
