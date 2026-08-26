import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { listRolloutSessions } from '../model-services/fileRolloutStorage.js';

export type SessionFeedbackRating = 'positive' | 'negative' | 'incomplete';

export interface BuildFingerprint {
  appVersion: string;
  commitSha?: string;
  promptVersion?: string;
  toolRegistryVersion?: string;
  model?: string;
  provider?: string;
  semanticIndexRevision?: string;
  ragCorpusRevision?: string;
}

export interface SessionFeedbackInput {
  sessionId: string;
  rating: SessionFeedbackRating;
  comment?: string;
}

export interface FeedbackTracePayload {
  sessionId: string;
  fileName: string;
  encoding: 'jsonl';
  content: string;
}

export type FeedbackUploadEnvelope =
  | {
      schemaVersion: 1;
      kind: 'session-feedback';
      submissionId: string;
      submittedAt: string;
      notify: true;
      build: BuildFingerprint;
      feedback: {
        rating: SessionFeedbackRating;
        comment?: string;
      };
      trace: FeedbackTracePayload;
    }
  | {
      schemaVersion: 1;
      kind: 'history-session';
      submissionId: string;
      submittedAt: string;
      notify: false;
      build: BuildFingerprint;
      partIndex: number;
      trace: FeedbackTracePayload;
    }
  | {
      schemaVersion: 1;
      kind: 'history-complete';
      submissionId: string;
      submittedAt: string;
      notify: true;
      build: BuildFingerprint;
      uploadedSessions: number;
      failedSessions: Array<{ sessionId: string; code: string }>;
    };

export type FeedbackEndpointResult =
  | { ok: true; status: number }
  | { ok: false; code: 'ENDPOINT_INVALID' | 'PAYLOAD_TOO_LARGE' | 'NETWORK_FAILED' | 'HTTP_REJECTED'; status?: number; message: string };

export interface FeedbackEndpoint {
  submit(payload: FeedbackUploadEnvelope): Promise<FeedbackEndpointResult>;
}

export interface HttpFeedbackEndpointOptions {
  maxPayloadBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Public-client endpoint: no Google/Gmail credential is stored here. The
 * endpoint URL is the only cloud coordinate the desktop app needs to know.
 */
export class HttpFeedbackEndpoint implements FeedbackEndpoint {
  private readonly maxPayloadBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointUrl: URL | null;

  constructor(endpoint: string, options: HttpFeedbackEndpointOptions = {}) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? 5 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpointUrl = parseHttpsEndpoint(endpoint);
  }

  async submit(payload: FeedbackUploadEnvelope): Promise<FeedbackEndpointResult> {
    if (!this.endpointUrl) {
      return { ok: false, code: 'ENDPOINT_INVALID', message: '反馈 endpoint 必须是有效的 HTTPS URL。' };
    }

    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > this.maxPayloadBytes) {
      return {
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: `反馈载荷 ${bytes} bytes 超过上限 ${this.maxPayloadBytes} bytes。`
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
        signal: controller.signal,
        redirect: 'error'
      });
      if (!response.ok) {
        return {
          ok: false,
          code: 'HTTP_REJECTED',
          status: response.status,
          message: `反馈 endpoint 返回 HTTP ${response.status}。`
        };
      }
      return { ok: true, status: response.status };
    } catch (error) {
      return {
        ok: false,
        code: 'NETWORK_FAILED',
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SessionFeedbackServiceOptions {
  maxSessions?: number;
  maxTraceBytes?: number;
}

export type SubmitSessionFeedbackResult =
  | { ok: true; submissionId: string }
  | { ok: false; code: 'INVALID_INPUT' | 'SESSION_NOT_FOUND' | 'TRACE_READ_FAILED' | 'TRACE_TOO_LARGE' | 'UPLOAD_FAILED'; message: string };

export interface SubmitAllHistoryResult {
  ok: boolean;
  submissionId: string;
  uploadedSessions: number;
  failedSessions: Array<{ sessionId: string; code: string }>;
}

/**
 * Bridges the existing append-only rollout JSONL authority to the remote
 * feedback sink. Renderer-facing callers identify a session by sessionId;
 * they never provide a filesystem path, preventing the feedback channel from
 * becoming an arbitrary local-file exfiltration primitive.
 */
export class SessionFeedbackService {
  private readonly maxSessions: number;
  private readonly maxTraceBytes: number;

  constructor(
    private readonly rolloutBaseDir: string,
    private readonly endpoint: FeedbackEndpoint,
    private readonly build: BuildFingerprint,
    options: SessionFeedbackServiceOptions = {}
  ) {
    this.maxSessions = options.maxSessions ?? 5_000;
    this.maxTraceBytes = options.maxTraceBytes ?? 4 * 1024 * 1024;
  }

  async submitSessionFeedback(input: SessionFeedbackInput): Promise<SubmitSessionFeedbackResult> {
    const validated = validateSessionFeedbackInput(input);
    if (!validated.ok) return validated;

    const sessions = await listRolloutSessions(this.rolloutBaseDir, this.maxSessions);
    const summary = sessions.find((candidate) => candidate.sessionId === input.sessionId);
    if (!summary || !summary.sessionId) {
      return { ok: false, code: 'SESSION_NOT_FOUND', message: '找不到对应的 Agent rollout 会话。' };
    }

    const trace = await this.readTrace(summary.path, summary.sessionId);
    if (!trace.ok) return trace;

    const submissionId = randomUUID();
    const feedback = input.comment === undefined
      ? { rating: input.rating }
      : { rating: input.rating, comment: input.comment.trim() };
    const result = await this.endpoint.submit({
      schemaVersion: 1,
      kind: 'session-feedback',
      submissionId,
      submittedAt: new Date().toISOString(),
      notify: true,
      build: this.build,
      feedback,
      trace: trace.value
    });
    if (!result.ok) {
      return { ok: false, code: 'UPLOAD_FAILED', message: result.message };
    }
    return { ok: true, submissionId };
  }

  /**
   * Full-history upload intentionally sends one sanitized rollout per request.
   * That keeps each public Web App request bounded and lets a partial network
   * failure be reported precisely instead of losing one giant bundle.
   */
  async submitAllHistory(): Promise<SubmitAllHistoryResult> {
    const submissionId = randomUUID();
    const sessions = await listRolloutSessions(this.rolloutBaseDir, this.maxSessions);
    const failedSessions: Array<{ sessionId: string; code: string }> = [];
    let uploadedSessions = 0;

    for (let index = 0; index < sessions.length; index += 1) {
      const summary = sessions[index];
      if (!summary?.sessionId) continue;
      const trace = await this.readTrace(summary.path, summary.sessionId);
      if (!trace.ok) {
        failedSessions.push({ sessionId: summary.sessionId, code: trace.code });
        continue;
      }

      const result = await this.endpoint.submit({
        schemaVersion: 1,
        kind: 'history-session',
        submissionId,
        submittedAt: new Date().toISOString(),
        notify: false,
        build: this.build,
        partIndex: index,
        trace: trace.value
      });
      if (result.ok) uploadedSessions += 1;
      else failedSessions.push({ sessionId: summary.sessionId, code: result.code });
    }

    const completion = await this.endpoint.submit({
      schemaVersion: 1,
      kind: 'history-complete',
      submissionId,
      submittedAt: new Date().toISOString(),
      notify: true,
      build: this.build,
      uploadedSessions,
      failedSessions
    });
    if (!completion.ok) {
      failedSessions.push({ sessionId: '__manifest__', code: completion.code });
    }

    return {
      ok: failedSessions.length === 0,
      submissionId,
      uploadedSessions,
      failedSessions
    };
  }

  private async readTrace(path: string, sessionId: string): Promise<
    | { ok: true; value: FeedbackTracePayload }
    | { ok: false; code: 'TRACE_READ_FAILED' | 'TRACE_TOO_LARGE'; message: string }
  > {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      return {
        ok: false,
        code: 'TRACE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error)
      };
    }

    if (Buffer.byteLength(raw, 'utf8') > this.maxTraceBytes) {
      return {
        ok: false,
        code: 'TRACE_TOO_LARGE',
        message: `会话 ${sessionId} 超过自动上传大小上限。`
      };
    }

    return {
      ok: true,
      value: {
        sessionId,
        fileName: basename(path),
        encoding: 'jsonl',
        content: sanitizeRolloutJsonl(raw)
      }
    };
  }
}

function parseHttpsEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
}

function validateSessionFeedbackInput(input: SessionFeedbackInput): SubmitSessionFeedbackResult | { ok: true } {
  if (input.sessionId.trim().length === 0 || input.sessionId.length > 160) {
    return { ok: false, code: 'INVALID_INPUT', message: 'sessionId 无效。' };
  }
  if (input.rating !== 'positive' && input.rating !== 'negative' && input.rating !== 'incomplete') {
    return { ok: false, code: 'INVALID_INPUT', message: 'feedback rating 无效。' };
  }
  if (input.comment !== undefined && input.comment.length > 2_000) {
    return { ok: false, code: 'INVALID_INPUT', message: '反馈文字过长。' };
  }
  return { ok: true };
}

const SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'password',
  'cookie',
  'setcookie',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'privatekey'
]);

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function sanitizeTraceValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeTraceValue(entry));
  if (value === null || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEYS.has(normalizeSecretKey(key))
      ? '[REDACTED]'
      : sanitizeTraceValue(child);
  }
  return output;
}

function redactSecretsInText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=:-]+/giu, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|cookie)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

/**
 * Preserve the rollout record shape and game/tool evidence. Only credential
 * fields and obvious credential strings are redacted. Malformed lines are
 * retained after text-level redaction rather than silently discarded.
 */
export function sanitizeRolloutJsonl(raw: string): string {
  const lines = raw.split('\n');
  return lines.map((line) => {
    if (line.trim() === '') return line;
    try {
      return JSON.stringify(sanitizeTraceValue(JSON.parse(line) as unknown));
    } catch {
      return redactSecretsInText(line);
    }
  }).join('\n');
}
