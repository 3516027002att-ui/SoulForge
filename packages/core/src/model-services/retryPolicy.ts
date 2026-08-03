/**
 * Two-tier retry/backoff policy for model-service calls.
 * Design derived from openai/codex (Apache-2.0, Copyright 2025 OpenAI) —
 * codex-client/retry.rs (request-level RetryPolicy) and responses_retry.rs
 * (stream-level retries). See licenses/openai-codex.txt.
 *
 * Codex semantics preserved:
 * - exponential backoff 200ms × 2^(attempt-1) with ±10% jitter
 * - server Retry-After takes precedence when larger than the computed delay
 * - explicit retryable whitelist derived from error classification
 * - attempt budget capped at 100
 * Divergence: Codex keeps HTTP 429 out of the request-level retry path
 * (rate limits land on the stream level via Retry-After). SoulForge treats
 * RATE_LIMITED as retryable on both paths and honors retryAfterMs, because
 * the non-streaming complete() path has no separate stream-level tier.
 */

import type { RetryPolicyOptions } from './types.js';

/** Structural diagnostic shape accepted by retry decisions. */
export interface RetryableDiagnosticInput {
  severity: string;
  code: string;
  message: string;
  retryAfterMs?: number;
}

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoffFactor: number;
  jitterRatio: number;
  maxDelayMs: number;
}

/** Stream-level retry budget when the loop consumes adapter.stream(). */
export const DEFAULT_STREAM_MAX_RETRIES = 5;
export const MAX_RETRY_ATTEMPTS_CAP = 100;

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  backoffFactor: 2,
  jitterRatio: 0.1,
  maxDelayMs: 30_000
};

/**
 * Retryable whitelist over the model-service error codes. Mirrors Codex's
 * CodexErr::is_retryable: timeouts, transport failures, rate limits and
 * server errors are retryable; cancellation, auth, client HTTP errors and
 * parse failures are terminal.
 */
const RETRYABLE_ERROR_CODES = new Set<string>([
  'MODEL_SERVICE_TIMEOUT',
  'MODEL_SERVICE_NETWORK_ERROR',
  'MODEL_SERVICE_RATE_LIMITED',
  'MODEL_SERVICE_SERVER_ERROR'
]);

export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

export function resolveRetryPolicy(options?: RetryPolicyOptions): ResolvedRetryPolicy {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
  return {
    maxAttempts: Math.min(Math.max(1, Math.floor(maxAttempts)), MAX_RETRY_ATTEMPTS_CAP),
    baseDelayMs: Math.max(0, options?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs),
    backoffFactor: Math.max(1, options?.backoffFactor ?? DEFAULT_RETRY_POLICY.backoffFactor),
    jitterRatio: Math.min(Math.max(0, options?.jitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio), 1),
    maxDelayMs: Math.max(0, options?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs)
  };
}

/**
 * Compute the backoff delay for a given attempt (1-based). When the server
 * supplied a Retry-After hint and it exceeds the computed delay, the hint
 * wins.
 */
export function computeBackoffDelayMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random
): number {
  const exponential = policy.baseDelayMs * policy.backoffFactor ** Math.max(0, attempt - 1);
  const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
  const bounded = Math.min(policy.maxDelayMs, exponential * jitter);
  return Math.max(Math.round(bounded), retryAfterMs ?? 0);
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  code?: string;
}

/**
 * Decide whether a failed completion should be retried. `attempt` is the
 * 1-based count of attempts already made (including the failed one).
 */
export function decideRetry(
  diagnostics: RetryableDiagnosticInput[],
  attempt: number,
  policy: ResolvedRetryPolicy,
  random: () => number = Math.random
): RetryDecision {
  const errorDiagnostic = [...diagnostics].reverse().find((entry) => entry.severity === 'error');
  if (!errorDiagnostic || !isRetryableErrorCode(errorDiagnostic.code)) {
    return { retry: false, delayMs: 0 };
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, code: errorDiagnostic.code };
  }
  return {
    retry: true,
    delayMs: computeBackoffDelayMs(policy, attempt, errorDiagnostic.retryAfterMs, random),
    code: errorDiagnostic.code
  };
}

/** Sleep that resolves early with 'cancelled' when the signal aborts. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<'ok' | 'cancelled'> {
  if (ms <= 0) {
    return Promise.resolve(signal?.aborted ? 'cancelled' : 'ok');
  }
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('cancelled');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve('cancelled');
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('ok');
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
