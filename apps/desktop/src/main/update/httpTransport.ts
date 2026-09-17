import {
  diagnostic,
  type UpdateDiagnostic,
  type UpdateTransport,
  type UpdateTransportRequestOptions,
  type UpdateTransportResponse
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const GITHUB_API_HOST = 'api.github.com';

export interface GitHubFetchTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

export class UpdateTransportError extends Error {
  public readonly diagnostic: UpdateDiagnostic;

  public constructor(diagnosticValue: UpdateDiagnostic) {
    super(diagnosticValue.message);
    this.name = 'UpdateTransportError';
    this.diagnostic = diagnosticValue;
  }
}

/** Only GitHub API/release hosts are accepted, including redirect targets. */
export function isAllowedGitHubUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === GITHUB_API_HOST
    || hostname === 'github.com'
    || hostname.endsWith('.github.com')
    || hostname === 'objects.githubusercontent.com'
    || hostname === 'release-assets.githubusercontent.com'
    || hostname.endsWith('.githubusercontent.com');
}

function asPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const contentLength = Number(lengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      throw new UpdateTransportError(diagnostic(
        'UPDATE_RESPONSE_TOO_LARGE',
        'check',
        'GitHub 响应超过大小上限。',
        false
      ));
    }
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new UpdateTransportError(diagnostic(
        'UPDATE_RESPONSE_TOO_LARGE',
        'check',
        'GitHub 响应超过大小上限。',
        false
      ));
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UpdateTransportError(diagnostic(
          'UPDATE_RESPONSE_TOO_LARGE',
          'check',
          'GitHub 响应超过大小上限。',
          false
        ));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mergeAbortSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { readonly signal: AbortSignal; readonly timedOut: () => boolean; readonly dispose: () => void } {
  const controller = new AbortController();
  let didTimeout = false;
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('UPDATE_TIMEOUT'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  };
}

export function createGitHubFetchTransport(options: GitHubFetchTransportOptions = {}): UpdateTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('当前 Node 运行时没有可用的 fetch。');
  const timeoutMs = asPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = asPositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxRedirects = asPositiveInteger(options.maxRedirects, MAX_REDIRECTS);

  return {
    async get(requestUrl: string, requestOptions: UpdateTransportRequestOptions = {}): Promise<UpdateTransportResponse> {
      if (!isAllowedGitHubUrl(requestUrl)) {
        throw new UpdateTransportError(diagnostic(
          'UPDATE_REDIRECT_FORBIDDEN',
          'check',
          '更新请求地址不是受信任的 GitHub HTTPS 地址。',
          false
        ));
      }

      let currentUrl = new URL(requestUrl);
      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const merged = mergeAbortSignal(requestOptions.signal, timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { accept: 'application/vnd.github+json' },
            signal: merged.signal
          });
        } catch (error) {
          merged.dispose();
          if (requestOptions.signal?.aborted) {
            throw new UpdateTransportError(diagnostic('UPDATE_CANCELLED', 'cancel', '更新请求已取消。', true));
          }
          if (merged.timedOut() || (error instanceof Error && error.message === 'UPDATE_TIMEOUT')) {
            throw new UpdateTransportError(diagnostic('UPDATE_TIMEOUT', 'check', 'GitHub 请求超时。', true));
          }
          throw new UpdateTransportError(diagnostic('UPDATE_NETWORK_FAILED', 'check', '无法连接 GitHub。', true));
        }
        if (response.status >= 300 && response.status < 400) {
          merged.dispose();
          const location = response.headers.get('location');
          if (!location || redirectCount === maxRedirects) {
            throw new UpdateTransportError(diagnostic(
              'UPDATE_REDIRECT_FORBIDDEN',
              'check',
              'GitHub 重定向超出安全限制。',
              false
            ));
          }
          const nextUrl = new URL(location, currentUrl);
          if (!isAllowedGitHubUrl(nextUrl.toString())) {
            throw new UpdateTransportError(diagnostic(
              'UPDATE_REDIRECT_FORBIDDEN',
              'check',
              'GitHub 重定向目标不是受信任的 GitHub HTTPS 地址。',
              false
            ));
          }
          currentUrl = nextUrl;
          continue;
        }

        try {
          const body = await readResponseBody(response, requestOptions.maxBytes ?? maxBytes);
          if (response.status < 200 || response.status >= 300) {
            throw new UpdateTransportError(diagnostic(
              'UPDATE_HTTP_ERROR',
              'check',
              'GitHub 返回了不可用的响应。',
              response.status >= 500,
              response.status
            ));
          }
          const finalUrl = response.url || currentUrl.toString();
          if (!isAllowedGitHubUrl(finalUrl)) {
            throw new UpdateTransportError(diagnostic(
              'UPDATE_REDIRECT_FORBIDDEN',
              'check',
              'GitHub 响应最终地址不是受信任的 GitHub HTTPS 地址。',
              false
            ));
          }
          return { status: response.status, url: finalUrl, body };
        } catch (error) {
          if (merged.timedOut()) {
            throw new UpdateTransportError(diagnostic('UPDATE_TIMEOUT', 'check', 'GitHub 响应读取超时。', true));
          }
          throw error;
        } finally {
          merged.dispose();
        }
      }
      throw new UpdateTransportError(diagnostic('UPDATE_REDIRECT_FORBIDDEN', 'check', 'GitHub 重定向失败。', false));
    }
  };
}
