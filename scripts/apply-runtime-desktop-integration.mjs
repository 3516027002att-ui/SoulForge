import { readFile, writeFile } from 'node:fs/promises';

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

async function write(path, content) {
  await writeFile(new URL(`../${path}`, import.meta.url), content, 'utf8');
}

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Missing anchor for ${label}`);
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Ambiguous anchor for ${label}`);
  }
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

function insertBeforeOnce(content, anchor, insertion, label) {
  return replaceOnce(content, anchor, `${insertion}${anchor}`, label);
}

async function patchSqliteSchema() {
  const path = 'packages/core/src/storage/sqliteSchema.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    "  }\n];\n\nexport const APP_DB_MIGRATIONS",
    `  },
  {
    id: 7,
    name: 'v0_5_runtime_launch_session_authority',
    sql: \`
CREATE TABLE IF NOT EXISTS runtime_launch_sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_path TEXT NOT NULL,
  operation_id TEXT,
  related_operation_id TEXT,
  verification_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT NOT NULL,
  exited_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  output_truncated INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_launch_sessions_workspace_started
  ON runtime_launch_sessions(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_launch_sessions_workspace_operation
  ON runtime_launch_sessions(workspace_id, operation_id, related_operation_id);
\`
  }
];

export const APP_DB_MIGRATIONS`,
    'workspace runtime migration'
  );
  content = replaceOnce(
    content,
    "  }\n];\n\nexport function getLatestSchemaVersion",
    `  },
  {
    id: 2,
    name: 'v0_5_runtime_adapter_settings_authority',
    sql: \`
CREATE TABLE IF NOT EXISTS runtime_adapter_settings (
  adapter_id TEXT PRIMARY KEY,
  executable_path TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
\`
  }
];

export function getLatestSchemaVersion`,
    'app runtime migration'
  );
  await write(path, content);
}

async function patchRendererDto() {
  const path = 'apps/desktop/src/main/rendererDto.ts';
  let content = await read(path);
  content = insertBeforeOnce(
    content,
    "import type {\n  BridgeResult,",
    "import type { RuntimeCapability, RuntimeLaunchRecord } from '@soulforge/core';\n",
    'renderer DTO core import'
  );
  content = insertBeforeOnce(
    content,
    'const SENSITIVE_PATH_KEYS',
    `export interface RendererRuntimeCapability {
  adapterId: string;
  status: RuntimeCapability['status'];
  configured: boolean;
  version?: string;
  diagnostics: Diagnostic[];
}

export type RendererRuntimeLaunchRecord = Omit<
  RuntimeLaunchRecord,
  'workspaceId' | 'profilePath' | 'stdout' | 'stderr' | 'diagnostics'
> & {
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
};

export interface RendererRuntimeActionResult {
  ok: boolean;
  capability?: RendererRuntimeCapability;
  record?: RendererRuntimeLaunchRecord;
  records?: RendererRuntimeLaunchRecord[];
  removed?: boolean;
  diagnostics: Diagnostic[];
}

`,
    'renderer runtime DTO types'
  );
  content = replaceOnce(
    content,
    "  'storePath',\n  // Model-service secrets",
    "  'storePath',\n  'profilePath',\n  'executablePath',\n  // Model-service secrets",
    'runtime sensitive path keys'
  );
  content = insertBeforeOnce(
    content,
    'export function sanitizeDiagnostics',
    `export function toRendererRuntimeCapability(
  capability: RuntimeCapability,
  configured: boolean
): RendererRuntimeCapability {
  return {
    adapterId: capability.adapterId,
    status: capability.status,
    configured,
    ...(capability.version ? { version: capability.version } : {}),
    diagnostics: sanitizeDiagnostics(capability.diagnostics)
  };
}

export function toRendererRuntimeLaunchRecord(
  record: RuntimeLaunchRecord
): RendererRuntimeLaunchRecord {
  return {
    sessionId: record.sessionId,
    adapterId: record.adapterId,
    profileId: record.profileId,
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.relatedOperationId ? { relatedOperationId: record.relatedOperationId } : {}),
    verificationKind: record.verificationKind,
    state: record.state,
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    startedAt: record.startedAt,
    ...(record.exitedAt ? { exitedAt: record.exitedAt } : {}),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal ? { signal: record.signal } : {}),
    stdout: sanitizeRendererString(record.stdout),
    stderr: sanitizeRendererString(record.stderr),
    outputTruncated: record.outputTruncated,
    diagnostics: sanitizeDiagnostics(record.diagnostics),
    updatedAt: record.updatedAt
  };
}

`,
    'renderer runtime DTO mappers'
  );
  await write(path, content);
}

async function patchIpc() {
  const path = 'apps/desktop/src/main/ipc.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    "  toRendererResourcePreview,\n  toRendererSaveResult,",
    "  toRendererResourcePreview,\n  toRendererRuntimeCapability,\n  toRendererRuntimeLaunchRecord,\n  toRendererSaveResult,",
    'IPC runtime mapper imports'
  );
  content = replaceOnce(
    content,
    "  type RendererResourcePreview,\n  type RendererSaveResult",
    "  type RendererResourcePreview,\n  type RendererRuntimeActionResult,\n  type RendererSaveResult",
    'IPC runtime DTO type import'
  );
  content = insertBeforeOnce(
    content,
    "import { OperationLogUtilityClient }",
    "import { DesktopRuntimeController, runtimeErrorCode } from './runtimeController.js';\n",
    'IPC runtime controller import'
  );
  content = insertBeforeOnce(
    content,
    'const modelServiceVault =',
    `const runtimeController = new DesktopRuntimeController({
  applicationDataRoot: localApplicationDataRoot(),
  appDatabasePath: join(app.getPath('userData'), 'app.db'),
  authority: operationLogUtility
});
`,
    'IPC runtime controller instance'
  );
  content = replaceOnce(
    content,
    `export async function disposeOperationLogUtility(): Promise<void> {
  activeOperationLog = null;
  await operationLogUtility.dispose();
}
`,
    `export async function disposeRuntimeController(): Promise<void> {
  await runtimeController.dispose();
}

export async function disposeOperationLogUtility(): Promise<void> {
  activeOperationLog = null;
  await operationLogUtility.dispose();
}
`,
    'IPC runtime disposal export'
  );
  content = replaceOnce(
    content,
    `      if (activeSession) await disposeBridgeDaemonPool();
      activeSession = await openWorkspaceSession({`,
    `      await runtimeController.prepareForWorkspaceChange();
      if (activeSession) await disposeBridgeDaemonPool();
      activeSession = await openWorkspaceSession({`,
    'workspace switch runtime guard'
  );
  content = replaceOnce(
    content,
    `      const database = await ensureActiveOperationLog(activeSession);
      const scanJobId = randomUUID();`,
    `      const database = await ensureActiveOperationLog(activeSession);
      const recoveredRuntimeSessions = await runtimeController.attachWorkspace(activeSession);
      if (recoveredRuntimeSessions > 0) {
        process.stderr.write(
          \`[SoulForge runtime] marked \${recoveredRuntimeSessions} interrupted session(s) orphaned\\n\`
        );
      }
      const scanJobId = randomUUID();`,
    'workspace runtime attach'
  );
  const runtimeHandlers = `  handle('runtime.chooseMe3Executable', async (): Promise<RendererRuntimeActionResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择可信 me3 可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'me3 executable', extensions: ['exe'] }]
        : []
    });
    const executablePath = result.canceled ? undefined : result.filePaths[0];
    if (!executablePath) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'warning',
          code: 'ME3_SELECTION_CANCELLED',
          message: '用户取消了 me3 可执行文件选择。'
        }]
      };
    }
    try {
      const capability = await runtimeController.configureMe3(executablePath);
      return {
        ok: true,
        capability: toRendererRuntimeCapability(capability, true),
        diagnostics: sanitizeDiagnostics(capability.diagnostics)
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('runtime.clearMe3Executable', async (): Promise<RendererRuntimeActionResult> => {
    try {
      const removed = await runtimeController.clearMe3Configuration();
      const capability = await runtimeController.detect();
      return {
        ok: true,
        removed,
        capability: toRendererRuntimeCapability(capability, false),
        diagnostics: sanitizeDiagnostics(capability.diagnostics)
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('runtime.capability', async (): Promise<RendererRuntimeActionResult> => {
    try {
      const capability = await runtimeController.detect();
      const configured = !capability.diagnostics.some((item) => item.code === 'ME3_NOT_CONFIGURED');
      return {
        ok: capability.status === 'available',
        capability: toRendererRuntimeCapability(capability, configured),
        diagnostics: sanitizeDiagnostics(capability.diagnostics)
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('runtime.launchManual', async (): Promise<RendererRuntimeActionResult> => {
    return runtimeRecordAction(() => runtimeController.launchManual());
  });

  handle(
    'runtime.launchAfterCommit',
    async (_event, operationId: string): Promise<RendererRuntimeActionResult> => {
      return runtimeRecordAction(() => runtimeController.launchAfterCommit(operationId));
    }
  );

  handle(
    'runtime.launchAfterRollback',
    async (
      _event,
      inverseOperationId: string,
      originalOperationId: string
    ): Promise<RendererRuntimeActionResult> => {
      return runtimeRecordAction(() => runtimeController.launchAfterRollback(
        inverseOperationId,
        originalOperationId
      ));
    }
  );

  handle('runtime.listSessions', async (): Promise<RendererRuntimeActionResult> => {
    try {
      const records = await runtimeController.listSessions();
      return {
        ok: true,
        records: records.map(toRendererRuntimeLaunchRecord),
        diagnostics: []
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle(
    'runtime.getSession',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      try {
        const record = await runtimeController.getSession(sessionId);
        if (!record) {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error',
              code: 'RUNTIME_SESSION_NOT_FOUND',
              message: '找不到运行会话。'
            }]
          };
        }
        return { ok: true, record: toRendererRuntimeLaunchRecord(record), diagnostics: [] };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );

  handle(
    'runtime.terminate',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      return runtimeRecordAction(() => runtimeController.terminate(sessionId));
    }
  );

  handle(
    'runtime.waitForExit',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      return runtimeRecordAction(() => runtimeController.waitForExit(sessionId));
    }
  );

`;
  content = insertBeforeOnce(
    content,
    "  handle('operation.list'",
    runtimeHandlers,
    'runtime IPC handlers'
  );
  content = insertBeforeOnce(
    content,
    'export function registerIpcHandlers',
    `async function runtimeRecordAction(
  action: () => Promise<import('@soulforge/core').RuntimeLaunchRecord>
): Promise<RendererRuntimeActionResult> {
  try {
    const record = await action();
    return {
      ok: true,
      record: toRendererRuntimeLaunchRecord(record),
      diagnostics: sanitizeDiagnostics(record.diagnostics)
    };
  } catch (error) {
    return runtimeFailure(error);
  }
}

function runtimeFailure(error: unknown): RendererRuntimeActionResult {
  const diagnostic: Diagnostic = {
    severity: 'error',
    code: runtimeErrorCode(error),
    message: error instanceof Error ? error.message : String(error)
  };
  return { ok: false, diagnostics: sanitizeDiagnostics([diagnostic]) };
}

`,
    'runtime IPC helpers'
  );
  await write(path, content);
}

async function patchPreload() {
  const path = 'apps/desktop/src/preload/index.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    `  RendererResourcePreview,
  RendererSaveResult`,
    `  RendererResourcePreview,
  RendererRuntimeActionResult,
  RendererSaveResult`,
    'preload runtime DTO import'
  );
  content = insertBeforeOnce(
    content,
    `  listOperations: ()`,
    `  chooseMe3Executable: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.chooseMe3Executable'),
  clearMe3Executable: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.clearMe3Executable'),
  getRuntimeCapability: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.capability'),
  launchRuntime: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.launchManual'),
  launchRuntimeAfterCommit: (operationId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.launchAfterCommit', operationId),
  launchRuntimeAfterRollback: (
    inverseOperationId: string,
    originalOperationId: string
  ): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.launchAfterRollback', inverseOperationId, originalOperationId),
  listRuntimeSessions: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.listSessions'),
  getRuntimeSession: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.getSession', sessionId),
  terminateRuntimeSession: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.terminate', sessionId),
  waitForRuntimeExit: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.waitForExit', sessionId),
`,
    'preload runtime APIs'
  );
  await write(path, content);
}

async function patchMainIndex() {
  const path = 'apps/desktop/src/main/index.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    `import { disposeOperationLogUtility, registerIpcHandlers } from './ipc.js';`,
    `import {
  disposeOperationLogUtility,
  disposeRuntimeController,
  registerIpcHandlers
} from './ipc.js';`,
    'main runtime disposal import'
  );
  content = replaceOnce(
    content,
    `  void Promise.allSettled([
    disposeBridgeDaemonPool(),
    disposeOperationLogUtility()
  ]).finally(() => app.quit());`,
    `  void disposeRuntimeController()
    .catch((error) => {
      process.stderr.write(\`[SoulForge runtime shutdown] \${String(error)}\\n\`);
    })
    .then(() => Promise.allSettled([
      disposeBridgeDaemonPool(),
      disposeOperationLogUtility()
    ]))
    .finally(() => app.quit());`,
    'main ordered runtime shutdown'
  );
  await write(path, content);
}

async function patchDatabaseUtilitySmoke() {
  const path = 'apps/desktop/src/main/databaseUtilitySmoke.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    `    await client.openWorkspace({`,
    `    await client.openApp({ appDatabasePath: join(root, 'app.db') });
    const runtimeSettingTime = '2026-07-24T00:00:00.000Z';
    await client.upsertRuntimeAdapterSetting({
      adapterId: 'me3',
      executablePath: resolve(process.execPath),
      confirmedAt: runtimeSettingTime,
      updatedAt: runtimeSettingTime
    });
    if ((await client.getRuntimeAdapterSetting('me3'))?.executablePath !== resolve(process.execPath)) {
      throw new Error('App database runtime setting authority round trip failed.');
    }
    await client.openWorkspace({`,
    'database smoke app runtime setting'
  );
  content = insertBeforeOnce(
    content,
    `    await client.restart();`,
    `    await client.upsertRuntimeSession({
      sessionId: 'utility-runtime-session',
      workspaceId,
      adapterId: 'me3',
      profileId: 'utility-profile',
      profilePath: join(root, 'runtime', 'utility.me3'),
      operationId: direct.opId,
      verificationKind: 'post_commit',
      state: 'exited',
      pid: 123,
      startedAt: runtimeSettingTime,
      exitedAt: '2026-07-24T00:00:01.000Z',
      exitCode: 0,
      stdout: 'fixture runtime output',
      stderr: '',
      outputTruncated: false,
      diagnostics: [{
        severity: 'info',
        code: 'RUNTIME_FIXTURE_ONLY',
        message: 'No real game was launched.'
      }],
      updatedAt: '2026-07-24T00:00:01.000Z'
    });
    if ((await client.getRuntimeSession('utility-runtime-session'))?.exitCode !== 0
      || (await client.listRuntimeSessions(workspaceId)).length !== 1) {
      throw new Error('Workspace runtime session authority round trip failed.');
    }
`,
    'database smoke runtime session'
  );
  content = replaceOnce(
    content,
    `      || (await client.searchFiles('test')).length !== 1
      || (await client.listJobs()).length !== 1) {`,
    `      || (await client.searchFiles('test')).length !== 1
      || (await client.listJobs()).length !== 1
      || (await client.getRuntimeAdapterSetting('me3'))?.adapterId !== 'me3'
      || (await client.getRuntimeSession('utility-runtime-session'))?.state !== 'exited') {`,
    'database smoke restart runtime authority'
  );
  content = replaceOnce(
    content,
    `      indexRepositories: true,
      forcedRestart: true`,
    `      indexRepositories: true,
      runtimeAuthorities: true,
      forcedRestart: true`,
    'database smoke summary'
  );
  await write(path, content);
}

async function patchCorePackage() {
  const path = 'packages/core/package.json';
  let content = await read(path);
  content = replaceOnce(
    content,
    ` && node dist/testing/runMe3RuntimeAdapterSmoke.js",`,
    ` && node dist/testing/runMe3RuntimeAdapterSmoke.js && node dist/testing/runRuntimeSessionManagerSmoke.js",`,
    'core aggregate runtime manager smoke'
  );
  content = replaceOnce(
    content,
    `    "test:me3-runtime-adapter": "tsc -b ../shared . && node dist/testing/runMe3RuntimeAdapterSmoke.js",`,
    `    "test:me3-runtime-adapter": "tsc -b ../shared . && node dist/testing/runMe3RuntimeAdapterSmoke.js",
    "test:runtime-session-manager": "tsc -b ../shared . && node dist/testing/runRuntimeSessionManagerSmoke.js",`,
    'core runtime manager script'
  );
  await write(path, content);
}

async function patchRootPackage() {
  const path = 'package.json';
  let content = await read(path);
  content = replaceOnce(
    content,
    `    "test:me3-runtime-adapter": "npm run test:me3-runtime-adapter -w @soulforge/core",`,
    `    "test:me3-runtime-adapter": "npm run test:me3-runtime-adapter -w @soulforge/core",
    "test:runtime-session-manager": "npm run test:runtime-session-manager -w @soulforge/core",`,
    'root runtime manager script'
  );
  await write(path, content);
}

await patchSqliteSchema();
await patchRendererDto();
await patchIpc();
await patchPreload();
await patchMainIndex();
await patchDatabaseUtilitySmoke();
await patchCorePackage();
await patchRootPackage();
console.log('runtime desktop integration migration applied');
