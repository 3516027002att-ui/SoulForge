import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  RuntimeSessionManager,
  RuntimeSessionManagerError,
  TrustedMe3RuntimeAdapter,
  type OperationLogStore,
  type RuntimeAdapterSetting,
  type RuntimeCapability,
  type RuntimeLaunchRecord,
  type RuntimeLaunchSessionStore,
  type WorkspaceSession
} from '@soulforge/core';
import type { OperationLogRecord } from '@soulforge/shared';

export interface RuntimeAuthorityClient extends RuntimeLaunchSessionStore {
  openApp(payload: { appDatabasePath: string }): Promise<void>;
  getRuntimeAdapterSetting(adapterId: string): Promise<RuntimeAdapterSetting | undefined>;
  upsertRuntimeAdapterSetting(setting: RuntimeAdapterSetting): Promise<void>;
  deleteRuntimeAdapterSetting(adapterId: string): Promise<boolean>;
  get(opId: string): Promise<OperationLogRecord | undefined>;
}

export interface DesktopRuntimeControllerOptions {
  applicationDataRoot: string;
  appDatabasePath: string;
  authority: RuntimeAuthorityClient;
  now?: () => Date;
}

export class DesktopRuntimeController {
  private readonly applicationDataRoot: string;
  private readonly appDatabasePath: string;
  private readonly authority: RuntimeAuthorityClient;
  private readonly now: () => Date;
  private workspace: WorkspaceSession | null = null;
  private manager: RuntimeSessionManager | null = null;

  constructor(options: DesktopRuntimeControllerOptions) {
    this.applicationDataRoot = options.applicationDataRoot;
    this.appDatabasePath = options.appDatabasePath;
    this.authority = options.authority;
    this.now = options.now ?? (() => new Date());
  }

  async initializeAppAuthority(): Promise<void> {
    await mkdir(this.applicationDataRoot, { recursive: true });
    await this.authority.openApp({ appDatabasePath: this.appDatabasePath });
  }

  async prepareForWorkspaceChange(): Promise<void> {
    if (this.manager?.hasActiveSessions()) {
      throw new DesktopRuntimeControllerError(
        'RUNTIME_WORKSPACE_SWITCH_ACTIVE_SESSION',
        '运行会话仍在活动中；请先终止或等待退出，再切换工作区。'
      );
    }
  }

  async attachWorkspace(workspace: WorkspaceSession): Promise<number> {
    await this.prepareForWorkspaceChange();
    if (this.manager) await this.manager.dispose();
    this.workspace = workspace;
    this.manager = null;
    const manager = await this.getManager(false);
    return manager ? manager.recoverInterruptedSessions() : 0;
  }

  async configureMe3(executablePath: string): Promise<RuntimeCapability> {
    await this.initializeAppAuthority();
    if (!isAbsolute(executablePath)) {
      throw new DesktopRuntimeControllerError(
        'ME3_EXECUTABLE_PATH_NOT_ABSOLUTE',
        'me3 executable path must be absolute.'
      );
    }
    if (this.manager?.hasActiveSessions()) {
      throw new DesktopRuntimeControllerError(
        'ME3_RECONFIGURE_ACTIVE_SESSION',
        '运行会话仍在活动中，不能更换 me3 可执行文件。'
      );
    }
    const adapter = this.createAdapter(executablePath);
    const capability = await adapter.detect();
    if (capability.status !== 'available') {
      throw new DesktopRuntimeControllerError(
        'ME3_EXECUTABLE_REJECTED',
        capability.diagnostics.map((item) => item.message).join('; ') || 'me3 executable is unavailable.',
        capability.diagnostics
      );
    }
    const now = this.now().toISOString();
    await this.authority.upsertRuntimeAdapterSetting({
      adapterId: 'me3',
      executablePath,
      confirmedAt: now,
      updatedAt: now
    });
    if (this.manager) await this.manager.dispose();
    this.manager = this.workspace ? this.createManager(adapter, this.workspace) : null;
    return capability;
  }

  async clearMe3Configuration(): Promise<boolean> {
    await this.initializeAppAuthority();
    if (this.manager?.hasActiveSessions()) {
      throw new DesktopRuntimeControllerError(
        'ME3_CLEAR_ACTIVE_SESSION',
        '运行会话仍在活动中，不能清除 me3 配置。'
      );
    }
    if (this.manager) await this.manager.dispose();
    this.manager = null;
    return this.authority.deleteRuntimeAdapterSetting('me3');
  }

  async detect(): Promise<RuntimeCapability> {
    await this.initializeAppAuthority();
    const setting = await this.authority.getRuntimeAdapterSetting('me3');
    if (!setting) return unconfiguredCapability();
    return this.createAdapter(setting.executablePath).detect();
  }

  async launchManual(): Promise<RuntimeLaunchRecord> {
    return (await this.requireManager().launch()).record;
  }

  async launchAfterCommit(operationId: string): Promise<RuntimeLaunchRecord> {
    const operation = await this.requireCommittedOperation(operationId);
    if (operation.inverseOfOpId) {
      throw new DesktopRuntimeControllerError(
        'RUNTIME_POST_COMMIT_EXPECTED_FORWARD_OPERATION',
        '提交后验证要求正向操作；该操作是回滚 inverse。'
      );
    }
    return (await this.requireManager().launch({
      operationId,
      verificationKind: 'post_commit'
    })).record;
  }

  async launchAfterRollback(
    inverseOperationId: string,
    originalOperationId: string
  ): Promise<RuntimeLaunchRecord> {
    const inverse = await this.requireCommittedOperation(inverseOperationId);
    if (inverse.inverseOfOpId !== originalOperationId) {
      throw new DesktopRuntimeControllerError(
        'RUNTIME_ROLLBACK_LINK_MISMATCH',
        'inverse operation 与原操作的持久关联不匹配。',
        { inverseOperationId, originalOperationId, actualInverseOf: inverse.inverseOfOpId }
      );
    }
    return (await this.requireManager().launch({
      operationId: inverseOperationId,
      relatedOperationId: originalOperationId,
      verificationKind: 'post_rollback'
    })).record;
  }

  async terminate(sessionId: string): Promise<RuntimeLaunchRecord> {
    return this.requireManager().terminate(sessionId);
  }

  async waitForExit(sessionId: string): Promise<RuntimeLaunchRecord> {
    return this.requireManager().waitForExit(sessionId);
  }

  async getSession(sessionId: string): Promise<RuntimeLaunchRecord | undefined> {
    if (this.manager) return this.manager.get(sessionId);
    return this.authority.getRuntimeSession(sessionId);
  }

  async listSessions(): Promise<RuntimeLaunchRecord[]> {
    const workspace = this.requireWorkspace();
    if (this.manager) return this.manager.list();
    return this.authority.listRuntimeSessions(workspace.meta.workspaceId);
  }

  async dispose(): Promise<void> {
    if (this.manager) await this.manager.dispose();
    this.manager = null;
    this.workspace = null;
  }

  private async getManager(required: boolean): Promise<RuntimeSessionManager | null> {
    if (this.manager) return this.manager;
    const workspace = this.workspace;
    if (!workspace) {
      if (required) this.requireWorkspace();
      return null;
    }
    await this.initializeAppAuthority();
    const setting = await this.authority.getRuntimeAdapterSetting('me3');
    if (!setting) {
      if (required) {
        throw new DesktopRuntimeControllerError(
          'ME3_NOT_CONFIGURED',
          '尚未通过主进程原生文件选择器确认 me3 可执行文件。'
        );
      }
      return null;
    }
    this.manager = this.createManager(this.createAdapter(setting.executablePath), workspace);
    return this.manager;
  }

  private requireManager(): Promise<RuntimeSessionManager> {
    return this.getManager(true).then((manager) => {
      if (!manager) throw new DesktopRuntimeControllerError('ME3_NOT_CONFIGURED', 'me3 runtime manager unavailable.');
      return manager;
    });
  }

  private requireWorkspace(): WorkspaceSession {
    if (!this.workspace) {
      throw new DesktopRuntimeControllerError(
        'RUNTIME_WORKSPACE_NOT_OPEN',
        '请先打开 Sekiro Mod 工作区。'
      );
    }
    return this.workspace;
  }

  private async requireCommittedOperation(operationId: string): Promise<OperationLogRecord> {
    const workspace = this.requireWorkspace();
    const operation = await this.authority.get(operationId);
    if (!operation || operation.workspaceId !== workspace.meta.workspaceId) {
      throw new DesktopRuntimeControllerError(
        'RUNTIME_OPERATION_NOT_FOUND',
        '找不到当前工作区中的目标 Patch operation。'
      );
    }
    if (operation.status !== 'committed') {
      throw new DesktopRuntimeControllerError(
        'RUNTIME_OPERATION_NOT_COMMITTED',
        `Patch operation 尚未提交，当前状态：${operation.status}。`
      );
    }
    return operation;
  }

  private createAdapter(executablePath: string): TrustedMe3RuntimeAdapter {
    return new TrustedMe3RuntimeAdapter({
      applicationDataRoot: this.applicationDataRoot,
      executablePath
    });
  }

  private createManager(
    adapter: TrustedMe3RuntimeAdapter,
    workspace: WorkspaceSession
  ): RuntimeSessionManager {
    return new RuntimeSessionManager({
      adapter,
      workspace,
      store: this.authority,
      now: this.now,
      onBackgroundError: (error) => {
        process.stderr.write(`[SoulForge runtime session] ${error.stack ?? error.message}\n`);
      }
    });
  }
}

export class DesktopRuntimeControllerError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function runtimeErrorCode(error: unknown): string {
  if (error instanceof DesktopRuntimeControllerError || error instanceof RuntimeSessionManagerError) {
    return error.code;
  }
  return 'RUNTIME_CONTROLLER_FAILED';
}

function unconfiguredCapability(): RuntimeCapability {
  return {
    adapterId: 'me3',
    status: 'unavailable',
    diagnostics: [{
      severity: 'warning',
      code: 'ME3_NOT_CONFIGURED',
      message: '尚未通过主进程原生文件选择器确认 me3 可执行文件。'
    }]
  };
}
