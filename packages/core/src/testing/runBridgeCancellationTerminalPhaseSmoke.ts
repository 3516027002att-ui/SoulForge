import {
  BridgeDaemonClient,
  BridgeDaemonError,
  type BridgeDaemonClientOptions,
  type BridgeDaemonRequestOptions,
  type BridgeCancellationTerminalReceipt
} from '../bridge/bridgeDaemonClient.js';
import {
  disposeBridgeDaemonPool,
  runBridge,
  type RunBridgeCancellationTerminalReceipt,
  type RunBridgeOptions
} from '../bridge/runBridge.js';

type Phase = RunBridgeCancellationTerminalReceipt['requestPhase'];
type FakeMode = 'command' | 'explicit-artifact' | 'artifact-child';

const projectPath = `${process.cwd()}\\bridge\\SoulForge.Bridge\\SoulForge.Bridge.csproj`;
const sourcePath = `${process.cwd()}\\package.json`;
let fakeMode: FakeMode = 'command';

async function main(): Promise<void> {
  const clientClass = BridgeDaemonClient as typeof BridgeDaemonClient;
  const originalStart = clientClass.start;
  clientClass.start = async (options: BridgeDaemonClientOptions) => createFakeClient(options);
  try {
    await assertPhase('command', {
      command: 'validate',
      workspaceSessionId: 'phase-command'
    });
    await assertPhase('artifact', {
      command: 'read-bridge-artifact',
      workspaceSessionId: 'phase-explicit-artifact'
    });

    fakeMode = 'artifact-child';
    const observed: RunBridgeCancellationTerminalReceipt[] = [];
    try {
      await runBridge({
        ...baseOptions('phase-artifact-child'),
        command: 'validate',
        onCancellationTerminal: (receipt) => { observed.push(receipt); }
      });
    } catch (error) {
      if (!(error instanceof BridgeDaemonError)) throw error;
    }
    if (observed.length !== 1 || observed[0]?.requestPhase !== 'artifact') {
      throw new Error(`Internal artifact request phase was not artifact: ${JSON.stringify(observed)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'fixture-confirmed',
      syntheticFixture: true,
      cases: {
        commandPhase: 'command',
        explicitArtifactPhase: 'artifact',
        internalArtifactPhase: 'artifact'
      },
      nonClaims: [
        'fake Bridge client only verifies runBridge callback phase projection.',
        '未运行 production Bridge、native parser、writer 或真实资源。'
      ]
    }, null, 2));
  } finally {
    clientClass.start = originalStart;
    await disposeBridgeDaemonPool();
  }
}

function baseOptions(workspaceSessionId: string): Omit<RunBridgeOptions, 'command'> {
  return {
    bridgeProjectPath: projectPath,
    bridgeExecutablePath: process.execPath,
    filePath: sourcePath,
    allowedRoots: [process.cwd()],
    workspaceSessionId,
    timeoutMs: 500
  };
}

async function assertPhase(
  expected: Phase,
  partial: Pick<RunBridgeOptions, 'command' | 'workspaceSessionId'>
): Promise<void> {
  fakeMode = partial.command === 'read-bridge-artifact' ? 'explicit-artifact' : 'command';
  const observed: RunBridgeCancellationTerminalReceipt[] = [];
  await runBridge({
    ...baseOptions(partial.workspaceSessionId ?? `phase-${expected}`),
    command: partial.command,
    onCancellationTerminal: (receipt) => { observed.push(receipt); }
  });
  if (observed.length !== 1 || observed[0]?.requestPhase !== expected) {
    throw new Error(`Expected ${expected} phase, got ${JSON.stringify(observed)}`);
  }
}

function createFakeClient(options: BridgeDaemonClientOptions): BridgeDaemonClient {
  const fake = {
    options,
    get isClosed() {
      return false;
    },
    request: async <T>(request: BridgeDaemonRequestOptions): Promise<{
      authority: 'candidate';
      nativeFormatAuthority: false;
      result: T;
    }> => {
      const command = request.payload.command;
      if (fakeMode === 'artifact-child' && command === 'validate') {
        return {
          authority: 'candidate',
          nativeFormatAuthority: false,
          result: {
            sourceUri: 'file://phase-fixture',
            sourcePath: 'phase-fixture',
            game: 'synthetic',
            resourceKind: 'document',
            parseStatus: 'partial',
            diagnostics: [],
            data: {
              fileBacked: {
                artifactToken: 'phase-fixture-token-1234',
                payloadFormat: 'bridge-result-json',
                payloadVersion: 1,
                byteLength: 1,
                chunkSize: 1
              }
            }
          } as T
        };
      }
      request.onCancellationTerminal?.(receiptFor(command));
      throw new BridgeDaemonError('BRIDGE_REQUEST_CANCELLED', 'synthetic cancellation', true);
    },
    dispose: async () => undefined
  } as unknown as BridgeDaemonClient;
  return fake;
}

function receiptFor(command: string): BridgeCancellationTerminalReceipt {
  return {
    requestId: `phase-${command}`,
    outcome: 'cancelled',
    receivedAt: new Date().toISOString(),
    cancelRequested: true
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
