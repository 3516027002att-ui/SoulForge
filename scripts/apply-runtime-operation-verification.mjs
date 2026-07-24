import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const write = (path, content) => writeFile(new URL(path, root), content, 'utf8');

function replaceOnce(content, from, to, label) {
  const count = content.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return content.replace(from, to);
}

async function patchRuntimeIpc() {
  const path = 'apps/desktop/src/main/runtimeIpc.ts';
  let text = await read(path);
  text = replaceOnce(
    text,
    '  toRendererRuntimeLaunchRecord,\n  toRendererRuntimeVerificationEvidence,',
    '  toRendererRuntimeLaunchRecord,\n  toRendererRuntimeOperationVerificationSummary,\n  toRendererRuntimeVerificationEvidence,',
    'runtime mapper import'
  );
  text = replaceOnce(
    text,
    `  handle(
    'runtime.getVerificationSummary',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const verification = await requireController().getVerificationSummary(
          assertIdentifier(sessionId)
        );
        return {
          ok: true,
          verification: toRendererRuntimeVerificationSummary(verification),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );
}`,
    `  handle(
    'runtime.getVerificationSummary',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const verification = await requireController().getVerificationSummary(
          assertIdentifier(sessionId)
        );
        return {
          ok: true,
          verification: toRendererRuntimeVerificationSummary(verification),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );

  handle(
    'runtime.getOperationVerificationSummary',
    async (_event, operationId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const operationVerification = await requireController().getOperationVerificationSummary(
          assertIdentifier(operationId)
        );
        return {
          ok: true,
          operationVerification: toRendererRuntimeOperationVerificationSummary(
            operationVerification
          ),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );
}`,
    'operation verification handler'
  );
  await write(path, text);
}

async function patchPreload() {
  const path = 'apps/desktop/src/preload/index.ts';
  let text = await read(path);
  text = replaceOnce(
    text,
    `  getRuntimeVerificationSummary: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.getVerificationSummary', sessionId),`,
    `  getRuntimeVerificationSummary: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.getVerificationSummary', sessionId),
  getOperationRuntimeVerificationSummary: (
    operationId: string
  ): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.getOperationVerificationSummary', operationId),`,
    'preload operation verification API'
  );
  await write(path, text);
}

async function patchSecurityGate() {
  const path = 'scripts/verify-desktop-security.mjs';
  let text = await read(path);
  text = replaceOnce(
    text,
    `  ['Runtime 进程成功不会自动宣称游戏加载', files.runtimeVerification.includes('gameLoadAutomaticallyVerified: false')
    && files.rendererDto.includes('gameLoadAutomaticallyVerified: false')],`,
    `  ['Runtime 进程成功不会自动宣称游戏加载', files.runtimeVerification.includes('gameLoadAutomaticallyVerified: false')
    && files.rendererDto.includes('gameLoadAutomaticallyVerified: false')],
  ['Runtime operation 汇总绑定正向与回滚会话', files.runtimeController.includes('getOperationVerificationSummary')
    && files.runtimeController.includes("record.verificationKind === 'post_rollback'")
    && files.runtimeIpc.includes("'runtime.getOperationVerificationSummary'")],
  ['Runtime verdict 使用上下文无关的预期状态语义', files.runtimeVerification.includes("'expected_state_observed'")
    && files.runtimeVerification.includes("'original_state_restored'")
    && !files.runtimeVerification.includes("'mod_loaded'")],`,
    'security operation verification checks'
  );
  await write(path, text);
}

await patchRuntimeIpc();
await patchPreload();
await patchSecurityGate();
console.log('runtime operation verification wiring applied');
