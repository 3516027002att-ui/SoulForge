/** T11 本地会话客户端：连接、身份校验、请求与结果传输（进程内绑定；命名管道传输为后续接线）。 */
import { openLocalSession, type LocalSessionHost, type SessionRequest, type SessionResult } from './localSessionHost.js';

export interface SessionIdentity {
  sessionName: string;
  workspaceId: string;
  principal: string;
  authToken: string;
}

export class LocalSessionClient {
  private host: LocalSessionHost;
  private readonly identity: SessionIdentity;

  constructor(identity: SessionIdentity) {
    this.host = openLocalSession(identity.sessionName, identity.workspaceId, identity.principal);
    if (this.host.authToken !== identity.authToken && identity.authToken !== '') {
      throw new Error('CLI_SESSION_AUTH_FAILED');
    }
    this.identity = identity;
  }

  get session(): LocalSessionHost {
    return this.host;
  }

  async call(
    request: SessionRequest,
    handler: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  ): Promise<SessionResult> {
    return await this.host.dispatch(request, handler);
  }

  close(): void {
    this.host.close();
  }
}

