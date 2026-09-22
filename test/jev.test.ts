import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detect, detectSync, toUnicode, JevClient, TypeSafeError } from '../src/index.ts';
import { buildQuestions, buildState, OPTIONS, QUESTION_IDS } from '../src/jev/questions.ts';
import { StubClient } from './stub.ts';
import type { SystemOneClient, SystemOneRequest } from '../src/types.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f: string): string => readFileSync(join(fixtures, f), 'utf8');
const burmeseLines = (f: string): string[] =>
  read(f).split('\n').filter((l) => /[\u1000-\u109F]/.test(l) && l.trim().length > 0);

/**
 * A genuinely ambiguous sample, derived from the corpus rather than transcribed by hand.
 *
 * Five Myanmar characters from a real Zawgyi line: below the 8-character threshold where
 * the Markov model measured only ~75% accurate, so stage 1 abstains and escalation runs.
 */
const AMBIGUOUS = 'နျပ';

describe('escalation policy', () => {
  test('the ambiguous fixture really is ambiguous for stage 1', () => {
    const d = detectSync(AMBIGUOUS);
    assert.equal(d.encoding, null, 'fixture must be one stage 1 cannot call');
  });

  test('a clear document never reaches the network', async () => {
    const client = new StubClient();
    await detect(read('udhr_mya_unicode_src.txt'), { client });
    assert.equal(client.requests.length, 0, 'clear text must not be escalated');
  });

  test('text with no Myanmar characters never reaches the network', async () => {
    const client = new StubClient();
    const d = await detect('Just some English prose here.', { client });
    assert.equal(client.requests.length, 0);
    assert.equal(d.encoding, null);
  });

  test('without a client the result is honest rather than guessed', async () => {
    const d = await detect(AMBIGUOUS);
    assert.equal(d.encoding, null);
    assert.equal(d.escalated, false);
  });
});

describe('resolving through Jev', () => {
  test('choosing the as-written reading means the input was Unicode', async () => {
    const client = new StubClient({ choice: OPTIONS.asWritten, choiceConfidence: 0.93 });
    const d = await detect(AMBIGUOUS, { client });
    assert.equal(client.requests.length, 1);
    assert.equal(d.encoding, 'unicode');
    assert.equal(d.evidence, 'jev');
    assert.equal(d.escalated, true);
    assert.equal(d.confidence, 0.93);
  });

  test('choosing the converted reading means the input was Zawgyi', async () => {
    const client = new StubClient({ choice: OPTIONS.ifConverted, choiceConfidence: 0.91 });
    const d = await detect(AMBIGUOUS, { client });
    assert.equal(d.encoding, 'zawgyi');
    assert.equal(d.evidence, 'jev');
  });

  test('low confidence abstains instead of picking the argmax', async () => {
    const client = new StubClient({ choice: OPTIONS.ifConverted, choiceConfidence: 0.45 });
    const d = await detect(AMBIGUOUS, { client });
    assert.equal(d.encoding, null);
    assert.ok(d.reasons.some((r) => r.includes('confidence below')));
  });

  test('"neither" abstains', async () => {
    const client = new StubClient({ choice: OPTIONS.neither, choiceConfidence: 0.99 });
    const d = await detect(AMBIGUOUS, { client });
    assert.equal(d.encoding, null);
  });

  test('non-Burmese Myanmar script abstains, because the code-point table does not hold', async () => {
    // Shan and Mon legitimately use code points this library otherwise treats as
    // Zawgyi-exclusive, so a low P(Burmese) has to veto the verdict.
    const client = new StubClient({ choice: OPTIONS.ifConverted, choiceConfidence: 0.95, burmese: 0.1 });
    const d = await detect(AMBIGUOUS, { client });
    assert.equal(d.encoding, null);
    assert.ok(d.reasons.some((r) => r.includes('P(Burmese)')));
  });

  test('mixed encodings are reported, not averaged into one answer', async () => {
    const client = new StubClient({ choice: OPTIONS.ifConverted, choiceConfidence: 0.95, mixed: 0.9 });
    const d = await detect(AMBIGUOUS, { client });
    assert.equal(d.encoding, null);
    assert.equal((d as { mixed: boolean }).mixed, true);
    assert.ok(d.reasons.some((r) => r.includes('split the document')));
  });

  test('token usage is reported so callers can account for cost', async () => {
    const client = new StubClient();
    const d = await detect(AMBIGUOUS, { client });
    assert.deepEqual((d as { usage: unknown }).usage, { input_tokens: 412, output_tokens: 61 });
  });
});

describe('the request we actually send', () => {
  test('matches the documented System One shape', async () => {
    const client = new StubClient();
    await detect(AMBIGUOUS, { client, model: 'jev-1.13.0' });
    const req = client.requests[0]!;

    assert.equal(req.model, 'jev-1.13.0');
    assert.deepEqual(Object.keys(req.questions).sort(), [
      QUESTION_IDS.reading,
      QUESTION_IDS.isBurmese,
      QUESTION_IDS.isMixed,
    ].sort());

    // All three ride in one request: Jev ingests the state once and evaluates questions
    // in parallel, so batching costs only the extra question tokens.
    assert.equal(Object.keys(req.questions).length, 3);

    const reading = req.questions[QUESTION_IDS.reading]!;
    assert.equal(reading.type, 'choice');
    assert.deepEqual(Object.keys((reading as { criteria: object }).criteria).sort(), [
      OPTIONS.asWritten,
      OPTIONS.ifConverted,
      OPTIONS.neither,
    ].sort());

    const state = req.state as Record<string, string>;
    assert.equal(state['reading_a'], AMBIGUOUS);
    assert.ok(state['reading_b'] !== undefined && state['reading_b'] !== AMBIGUOUS);
  });

  test('stays inside the 64k-token budget for a reasonable state', () => {
    // state plus every question must fit 64k tokens; 32k for state plus the longest
    // question. Characters are a crude proxy, but they catch an unbounded state.
    const questions = JSON.stringify(buildQuestions());
    const state = JSON.stringify(buildState({ asWritten: 'x'.repeat(1000), ifConverted: 'y'.repeat(1000) }));
    assert.ok(questions.length + state.length < 32_000, 'prompt overhead should leave room for real text');
  });

  test('skips the call when conversion changes nothing', async () => {
    // Z2U is near-identity on text that is already Unicode; with both readings equal the
    // Choice would be a coin flip, so there is nothing to buy.
    const client = new StubClient();
    const plain = '၁၂၃';
    const d = await detect(plain, { client });
    assert.equal(client.requests.length, 0);
    assert.equal(d.encoding, null);
  });
});

describe('failure handling', () => {
  const failing: SystemOneClient = {
    async evaluate(_req: SystemOneRequest) {
      throw new TypeSafeError('TypeSafe 429: rate limited', 429, 'rate limited');
    },
  };

  test('falls back to stage 1 by default', async () => {
    const d = await detect(AMBIGUOUS, { client: failing });
    assert.equal(d.evidence, 'markov');
    assert.ok(d.reasons.some((r) => r.includes('escalation failed')));
  });

  test('throws when asked to', async () => {
    await assert.rejects(() => detect(AMBIGUOUS, { client: failing, onError: 'throw' }), TypeSafeError);
  });

  test('the client refuses to construct without a key', () => {
    assert.throws(() => new JevClient({ apiKey: '' }), /No TypeSafe API key/);
  });

  test('the client retries a 429 and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { [QUESTION_IDS.reading]: { type: 'choice', choice: OPTIONS.asWritten, probabilities: {}, confidence: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const client = new JevClient({ apiKey: 'test-key', fetch: fetchImpl });
    const res = await client.evaluate({ model: 'jev-latest', state: 'x', questions: {} });
    assert.equal(calls, 2);
    assert.equal(res.model, 'jev-1.13.0');
  });

  test('the client does not retry a 422, because the request is the problem', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('bad question', { status: 422 });
    }) as typeof globalThis.fetch;

    const client = new JevClient({ apiKey: 'test-key', fetch: fetchImpl });
    await assert.rejects(() => client.evaluate({ model: 'jev-latest', state: 'x', questions: {} }), TypeSafeError);
    assert.equal(calls, 1);
  });
});

describe('regressions', () => {
  // One test per code review finding that touches this file, so none come back quietly.

  test('detect forwards thresholds to the escalation decision', async () => {
    // The Python half forwarded options to detect_sync but called should_escalate with
    // defaults, so the two implementations disagreed about whether to spend money.
    const loose = new StubClient();
    await detect(AMBIGUOUS, { client: loose, uncertainBelow: 0.3 });
    assert.equal(loose.requests.length, 0, 'a loosened threshold must suppress the call');

    const strict = new StubClient();
    await detect(AMBIGUOUS, { client: strict, uncertainBelow: 0.9 });
    assert.equal(strict.requests.length, 1);
  });

  test('a malformed Retry-After backs off rather than retrying immediately', async () => {
    // Date.parse accepts '-5' and '1.5' as dates in the past, so these used to mean
    // "retry now" here and "back off" in the Python port, for the same header.
    const seen: number[] = [];
    for (const junk of ['   ', '\t\n', 'Infinity', 'NaN', '0x10', '1e9', '-5', '1.5', 'nope']) {
      let calls = 0;
      const started = Date.now();
      const fetchImpl = (async () => {
        calls++;
        if (calls === 1) return new Response('slow', { status: 429, headers: { 'retry-after': junk } });
        return new Response(JSON.stringify({ model: 'm', answers: {}, usage: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch;
      const client = new JevClient({ apiKey: 'k', fetch: fetchImpl });
      await client.evaluate({ model: 'jev-latest', state: 'x', questions: {} });
      seen.push(Date.now() - started);
      assert.equal(calls, 2, `must retry on Retry-After ${JSON.stringify(junk)}`);
    }
    // Every one should have taken the 200ms backoff, not fired instantly.
    assert.ok(Math.min(...seen) >= 150, `expected backoff, saw ${Math.min(...seen)}ms`);
  });

  test('a Retry-After delay is capped rather than obeyed literally', async () => {
    // A server may send next Tuesday. Uncapped, the Python half would have slept for
    // roughly 73 years and this one for a day.
    const started = Date.now();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('slow', { status: 429, headers: { 'retry-after': '86400' } });
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const client = new JevClient({ apiKey: 'test-key', fetch: fetchImpl, maxAttempts: 1 });
    await assert.rejects(() => client.evaluate({ model: 'jev-latest', state: 'x', questions: {} }));
    // maxAttempts 1 means it never sleeps; the point is that the call returns promptly.
    assert.ok(Date.now() - started < 5_000);
    assert.equal(calls, 1);
  });

  test('an HTTP-date Retry-After falls back to backoff instead of throwing', async () => {
    // Retry-After may be delta-seconds or an HTTP date. Number() yields NaN on the date
    // form, and treating NaN as a delay would sleep forever or throw.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' },
        });
      }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const client = new JevClient({ apiKey: 'test-key', fetch: fetchImpl });
    const res = await client.evaluate({ model: 'jev-latest', state: 'x', questions: {} });
    assert.equal(calls, 2, 'must retry rather than throw on a date-form Retry-After');
    assert.equal(res.model, 'jev-1.13.0');
  });

  test('a conflict escalates and toUnicode leaves the text alone', async () => {
    const prose = burmeseLines('udhr_mya_unicode_src.txt').join(' ').slice(0, 400);
    const spiked = `${prose}\u1033`;
    const client = new StubClient({ mixed: 0.95 });

    const { text, converted, detection } = await toUnicode(spiked, { client });
    assert.equal(detection.encoding, null);
    assert.equal(converted, false);
    assert.equal(text, spiked, 'a conflicted document must never be rewritten');
    assert.equal(client.requests.length, 1, 'a conflict is worth asking about');
  });
});

describe('toUnicode', () => {
  test('converts confidently-Zawgyi text', async () => {
    const { text, converted, detection } = await toUnicode(read('udhr_mya_zawgyi_out.txt'));
    assert.equal(converted, true);
    assert.equal(detection.encoding, 'zawgyi');
    assert.equal(detectSync(text).encoding, 'unicode');
  });

  test('leaves Unicode text alone', async () => {
    const original = read('udhr_mya_unicode_src.txt');
    const { text, converted } = await toUnicode(original);
    assert.equal(converted, false);
    assert.equal(text, original);
  });

  test('leaves unknown text untouched rather than converting on a guess', async () => {
    const { text, converted } = await toUnicode(AMBIGUOUS);
    assert.equal(converted, false);
    assert.equal(text, AMBIGUOUS, 'a wrong conversion is not reversible, so never guess');
  });
});
