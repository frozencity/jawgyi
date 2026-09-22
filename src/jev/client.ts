import type { SystemOneClient, SystemOneRequest, SystemOneResponse } from '../types.ts';

export interface ClientOptions {
  /** Defaults to process.env.TYPESAFE_API_KEY where a process global exists. */
  apiKey?: string;
  /** Defaults to https://api.typesafe.ai/v1/systemone */
  endpoint?: string;
  /**
   * Pin this in production. `jev-latest` can move under you, and these questions were
   * calibrated against a specific model's behaviour.
   */
  model?: string;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Per-request timeout in ms. Default 5000. Jev's documented ceiling is ~500ms. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

export class TypeSafeError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = status;
    this.body = body;
  }
}

/** 429 and 529 are documented as retryable; 401 and 422 are caller errors and are not. */
const RETRYABLE = new Set([429, 529, 500, 502, 503, 504]);

/**
 * A server is allowed to send a Retry-After of next Tuesday. Honouring that literally
 * would park the caller for days, so the value is advice, not an instruction.
 */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Retry-After may be delta-seconds or an HTTP date. Number() gives NaN on the date form,
 * so parse both and fall back to exponential backoff when neither works.
 */
function retryDelayMs(headers: Headers, attempt: number): number {
  const backoff = 2 ** attempt * 100;
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return backoff;

  // RFC 9110 delta-seconds is 1*DIGIT and nothing else. Number() would also accept
  // '0x10', '1e9' and 'Infinity', which Python's float() rejects, so the two ports
  // disagreed on how long to wait for the same header.
  if (/^\d+$/.test(raw)) return Math.min(MAX_RETRY_DELAY_MS, Number(raw) * 1000);

  // Date.parse is far too permissive: it accepts '-5' and '1.5' as dates and returns a
  // time in the past, so a malformed header silently became "retry immediately" here and
  // "back off" in the Python port. Every HTTP-date form begins with a day name, so
  // require one before trusting the parse.
  if (!/^[A-Za-z]{3,9},? /.test(raw)) return backoff;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return backoff;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, when - Date.now()));
}

/**
 * Minimal HTTP client for the TypeSafe evaluation endpoint.
 *
 * Deliberately not the official SDK: this package has zero runtime dependencies so it can
 * be dropped into a browser or edge worker, and the surface it needs is one POST.
 * If you already depend on the official SDK, pass an adapter as your `SystemOneClient`.
 */
export class JevClient implements SystemOneClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    const envKey =
      typeof process !== 'undefined' ? process.env?.['TYPESAFE_API_KEY'] : undefined;
    const apiKey = options.apiKey ?? envKey;
    if (!apiKey) {
      throw new Error(
        'No TypeSafe API key. Pass { apiKey } or set TYPESAFE_API_KEY. ' +
          'Keys come from console.typesafe.ai. Note that resellers such as ' +
          'jevtypesafeai.com are not affiliated with TypeSafe.',
      );
    }
    this.apiKey = apiKey;
    this.endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model ?? 'jev-latest';
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
    const body = JSON.stringify({ ...request, model: request.model || this.model });
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        });

        if (res.ok) return (await res.json()) as SystemOneResponse;

        const text = await res.text().catch(() => '');
        const err = new TypeSafeError(`TypeSafe ${res.status}: ${text.slice(0, 200)}`, res.status, text);
        if (!RETRYABLE.has(res.status) || attempt === this.maxAttempts) throw err;
        lastError = err;
        await sleep(retryDelayMs(res.headers, attempt));
      } catch (e) {
        if (e instanceof TypeSafeError) throw e;
        if (attempt === this.maxAttempts) throw e;
        lastError = e;
        await sleep(2 ** attempt * 100);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('TypeSafe request failed');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
