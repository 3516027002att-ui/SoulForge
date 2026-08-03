/**
 * Structured error classification for model-service adapters.
 * Differentiates network, timeout, rate-limit, server, client and parse failures.
 */

import type { ModelCompleteResult, StreamEvent } from './types.js';

export interface ModelServiceDiagnostic {
  severity: 'error';
  code: string;
  message: string;
}

export interface FetchErrorClassificationOptions {
  /**
   * The caller-supplied signal (not the combined timeout+caller signal).
   * Lets the classifier distinguish an active caller cancellation
   * (MODEL_SERVICE_CANCELLED) from an internal timeout (MODEL_SERVICE_TIMEOUT)
   * instead of collapsing both into one code.
   */
  callerSignal?: AbortSignal | undefined;
}

export function classifyFetchError(
  error: unknown,
  protocol: string,
  signal?: AbortSignal,
  options?: FetchErrorClassificationOptions
): ModelServiceDiagnostic {
  const callerAborted = options?.callerSignal?.aborted ?? false;
  if (signal?.aborted || callerAborted) {
    if (callerAborted) {
      return {
        severity: 'error',
        code: 'MODEL_SERVICE_CANCELLED',
        message: `${protocol} 请求已取消。`
      };
    }
    const reason = signal?.reason as { name?: string } | undefined;
    if (reason?.name === 'TimeoutError') {
      return {
        severity: 'error',
        code: 'MODEL_SERVICE_TIMEOUT',
        message: `${protocol} 请求超时。`
      };
    }
    return {
      severity: 'error',
      code: 'MODEL_SERVICE_CANCELLED',
      message: `${protocol} 请求已取消。`
    };
  }
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    if (error.name === 'TimeoutError') {
      return {
        severity: 'error',
        code: 'MODEL_SERVICE_TIMEOUT',
        message: `${protocol} 请求超时。`
      };
    }
    return {
      severity: 'error',
      code: 'MODEL_SERVICE_CANCELLED',
      message: `${protocol} 请求已取消。`
    };
  }
  if (error instanceof TypeError) {
    return {
      severity: 'error',
      code: 'MODEL_SERVICE_NETWORK_ERROR',
      message: `${protocol} 网络连接失败：${error.message}`
    };
  }
  return {
    severity: 'error',
    code: 'MODEL_SERVICE_REQUEST_FAILED',
    message: `${protocol} 请求失败：${error instanceof Error ? error.message : String(error)}`
  };
}

export function classifyHttpError(
  status: number,
  bodyText: string,
  protocol: string,
  retryAfterHeader?: string | null
): ModelServiceDiagnostic {
  const truncated = bodyText.slice(0, 200);
  if (status === 429) {
    return {
      severity: 'error',
      code: 'MODEL_SERVICE_RATE_LIMITED',
      message: `${protocol} 速率限制 (HTTP 429)。${retryAfterHeader ? ` Retry-After: ${retryAfterHeader}。` : ''}${truncated ? ` ${truncated}` : ''}`
    };
  }
  if (status >= 500) {
    return {
      severity: 'error',
      code: 'MODEL_SERVICE_SERVER_ERROR',
      message: `${protocol} 服务端错误：HTTP ${status} ${truncated}`
    };
  }
  if (status === 401 || status === 403) {
    return {
      severity: 'error',
      code: 'MODEL_SERVICE_AUTH_ERROR',
      message: `${protocol} 认证/授权失败：HTTP ${status} ${truncated}`
    };
  }
  return {
    severity: 'error',
    code: 'MODEL_SERVICE_HTTP_ERROR',
    message: `${protocol} 请求失败：HTTP ${status} ${truncated}`
  };
}

export function classifyParseError(error: unknown, protocol: string): ModelServiceDiagnostic {
  return {
    severity: 'error',
    code: 'MODEL_SERVICE_RESPONSE_PARSE_FAILED',
    message: `${protocol} 响应解析失败：${error instanceof Error ? error.message : String(error)}`
  };
}

export function errorResult(
  diagnostic: ModelServiceDiagnostic
): ModelCompleteResult {
  return {
    message: { role: 'assistant', content: '' },
    finishReason: 'error',
    diagnostics: [diagnostic]
  };
}

export function errorStreamEvent(
  diagnostic: ModelServiceDiagnostic
): StreamEvent {
  return {
    type: 'error',
    code: diagnostic.code,
    message: diagnostic.message
  };
}

/**
 * Create a combined AbortSignal from an optional caller signal and an optional timeout.
 * Returns the signal and a cleanup function to clear the timeout timer.
 */
export function createRequestSignal(
  callerSignal?: AbortSignal,
  timeoutMs?: number
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!callerSignal && !timeoutMs) {
    return { signal: undefined, cleanup: () => {} };
  }
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    signals.push(timeoutSignal);
  }
  if (signals.length === 1) {
    return { signal: signals[0], cleanup: () => { if (timer) clearTimeout(timer); } };
  }
  const combined = AbortSignal.any(signals);
  return { signal: combined, cleanup: () => { if (timer) clearTimeout(timer); } };
}
