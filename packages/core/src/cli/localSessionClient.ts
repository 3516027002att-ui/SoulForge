/**
 * Local session client: connects to same-user host, authenticates with token,
 * sends tool calls. Never embeds credentials in tool results.
 */
import { randomBytes } from 'node:crypto';

export interface LocalSessionClientOptions {
  sessionKey: string;
  token: string;
  send: (frame: unknown) => Promise<unknown>;
}

export interface LocalSessionHandshake {
  protocolVersion: string;
  workspaceKey: string;
  modeCeiling: string;
  sessionKey?: string;
  gameId?: string;
  metadataConfigId?: string;
  sessionName?: string;
  userIdentity?: string;
}

export type LocalSessionHandshakeCheck =
  | { ok: true; handshake: Required<Pick<LocalSessionHandshake, 'protocolVersion' | 'workspaceKey' | 'modeCeiling'>> & LocalSessionHandshake }
  | { ok: false; code: string; message: string };

export const LOCAL_SESSION_PROTOCOL_VERSION = 'sf-local-session/1';

const MODE_CEILINGS = new Set(['plan', 'normal', 'fullPermission']);

export class LocalSessionClient {
  private readonly options: LocalSessionClientOptions;
  private requestSeq = 0;

  constructor(options: LocalSessionClientOptions) {
    this.options = options;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.requestSeq += 1;
    const id = `req-${this.requestSeq}`;
    return this.options.send({
      id,
      tool,
      args,
      auth: this.options.token
    });
  }

  async close(): Promise<void> {
    await this.options.send({ id: `close-${Date.now()}`, tool: 'session_close', args: {}, auth: this.options.token });
  }
}

export function createLocalSessionClient(options: LocalSessionClientOptions): LocalSessionClient {
  return new LocalSessionClient(options);
}

/** Cryptographic session token; length >= 32 bytes. */
export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Host key derivation — config mismatch cannot join the same runtime. */
export function deriveSessionHostKey(input: {
  protocolVersion: string;
  userIdentity: string;
  workspaceKey: string;
  gameId?: string;
  metadataConfigId?: string;
  modeCeiling: string;
  sessionName: string;
}): string {
  return JSON.stringify([
    input.protocolVersion,
    input.userIdentity,
    input.workspaceKey,
    input.gameId ?? '',
    input.metadataConfigId ?? '',
    input.modeCeiling,
    input.sessionName
  ]);
}

/**
 * Validate handshake fields before any tool call is allowed on the channel.
 * Missing/invalid protocolVersion, workspaceKey or modeCeiling fail closed.
 */
export function validateLocalSessionHandshake(handshake: unknown): LocalSessionHandshakeCheck {
  if (!handshake || typeof handshake !== 'object' || Array.isArray(handshake)) {
    return { ok: false, code: 'CLI_SESSION_HANDSHAKE_INVALID', message: 'handshake 必须是对象。' };
  }
  const record = handshake as Record<string, unknown>;
  const protocolVersion = typeof record.protocolVersion === 'string' ? record.protocolVersion.trim() : '';
  const workspaceKey = typeof record.workspaceKey === 'string' ? record.workspaceKey.trim() : '';
  const modeCeiling = typeof record.modeCeiling === 'string' ? record.modeCeiling.trim() : '';
  if (!protocolVersion) {
    return { ok: false, code: 'CLI_SESSION_HANDSHAKE_PROTOCOL', message: 'handshake 缺少 protocolVersion。' };
  }
  if (!workspaceKey) {
    return { ok: false, code: 'CLI_SESSION_HANDSHAKE_WORKSPACE', message: 'handshake 缺少 workspaceKey。' };
  }
  if (!modeCeiling || !MODE_CEILINGS.has(modeCeiling)) {
    return {
      ok: false,
      code: 'CLI_SESSION_HANDSHAKE_MODE_CEILING',
      message: 'handshake modeCeiling 必须是 plan|normal|fullPermission。'
    };
  }
  return {
    ok: true,
    handshake: {
      protocolVersion,
      workspaceKey,
      modeCeiling: modeCeiling as 'plan' | 'normal' | 'fullPermission',
      ...(typeof record.sessionKey === 'string' ? { sessionKey: record.sessionKey } : {}),
      ...(typeof record.gameId === 'string' ? { gameId: record.gameId } : {}),
      ...(typeof record.metadataConfigId === 'string' ? { metadataConfigId: record.metadataConfigId } : {}),
      ...(typeof record.sessionName === 'string' ? { sessionName: record.sessionName } : {}),
      ...(typeof record.userIdentity === 'string' ? { userIdentity: record.userIdentity } : {})
    }
  };
}

/**
 * Connect helper: handshake must validate before the client can send tool calls.
 * The token is never written to stdout by this helper.
 */
export async function connectLocalSession(options: {
  handshake: unknown;
  sessionKey?: string;
  token: string;
  send: (frame: unknown) => Promise<unknown>;
  /** Optional live host handshake probe executed after field validation. */
  onConnect?: (handshake: LocalSessionHandshakeCheck & { ok: true }) => Promise<unknown> | unknown;
}): Promise<
  | { ok: true; client: LocalSessionClient; handshake: LocalSessionHandshakeCheck & { ok: true } }
  | { ok: false; code: string; message: string }
> {
  const check = validateLocalSessionHandshake(options.handshake);
  if (!check.ok) return check;
  const sessionKey = options.sessionKey
    ?? (typeof check.handshake.sessionKey === 'string' ? check.handshake.sessionKey : '');
  if (!sessionKey) {
    return { ok: false, code: 'CLI_SESSION_HANDSHAKE_SESSION_KEY', message: 'connectLocalSession 需要 sessionKey。' };
  }
  if (options.token.length < 32) {
    return { ok: false, code: 'CLI_SESSION_TOKEN_INVALID', message: 'session token 长度必须 >= 32 字节。' };
  }
  if (options.onConnect) {
    try {
      await options.onConnect(check);
    } catch (error) {
      return {
        ok: false,
        code: 'CLI_SESSION_CONNECT_FAILED',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return {
    ok: true,
    handshake: check,
    client: createLocalSessionClient({
      sessionKey,
      token: options.token,
      send: options.send
    })
  };
}
