import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

const FIRST_PAGE_SIZE = 20;
const PROBE_PROFILES = [
  { label: 'small', entryIndex: 1, expectedType: 'ACTION_GUIDE_PARAM_ST' },
  { label: 'large', entryIndex: 118, expectedType: 'SP_EFFECT_PARAM_ST' }
] as const;

interface NativeTelemetry {
  paramParse?: number;
  paramDecodedRows?: number;
  paramSessionOpen?: number;
  paramStructuralValidation?: number;
  paramSerializedRows?: number;
}

interface ParamReadData {
  sourceHash?: string;
  typeName?: string;
  rowCount?: number;
  rowDataSize?: number;
  payloadsIncluded?: boolean;
  sessionToken?: string;
  rows?: Array<{
    rowIndex?: number;
    id: number;
    dataBase64?: string | null;
    dataHash?: string;
  }>;
  telemetry?: NativeTelemetry;
}

interface TimingObservation {
  profile: string;
  entryIndex: number;
  mode: 'lazy-index' | 'legacy-full-document';
  fileBytes: number;
  expectedType: string;
  actualType: string | null;
  requestStart: string;
  responseReady: string;
  elapsedMs: number;
  declaredRowCount: number | null;
  rowDataSize: number | null;
  returnedRowCount: number;
  payloadRowsReturned: number;
  payloadBytesReturned: number;
  decodedRowCountBeforeFirstRows: number | null;
  offscreenRowsMaterialized: boolean | null;
  nativeFullParseCount: number | null;
  telemetryDelta: NativeTelemetry;
  diagnosticCodes: string[];
  evidence: string;
}

async function main(): Promise<void> {
  const sourceBnd = await resolveNativeFixture(
    process.argv[2],
    'param-primary',
    '../../mods/param/gameparam/gameparam.parambnd.dcx'
  );
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-param-probe-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  const observations: TimingObservation[] = [];

  try {
    for (const profile of PROBE_PROFILES) {
      const paramPath = join(staging, `probe-${profile.entryIndex}.param`);
      const extractStart = performance.now();
      const extract = await runBridge<{ contentSize?: number }>({
        command: 'extract-bnd4-child',
        filePath: sourceBnd,
        allowedRoots: [dirname(sourceBnd)],
        writableRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { entryIndex: profile.entryIndex, outputPath: paramPath }
      });
      const extractElapsedMs = roundMs(performance.now() - extractStart);
      if (extract.parseStatus === 'failed') {
        throw new Error(
          `PARAM probe extract failed for ${profile.label}/${profile.entryIndex} `
          + `(${extractElapsedMs}ms): ${extract.diagnostics.map((d) => d.code).join(', ')}`
        );
      }
      const fileBytes = (await stat(paramPath)).size;

      // 每个模式都重启一次 Bridge daemon：telemetry 是进程累计值，重启后
      // 这里的快照就是本次首屏请求的 delta，不把前一个模式混进来。
      observations.push(await observeRead({
        profile,
        paramPath,
        fileBytes,
        mode: 'lazy-index',
        commandOptions: {
          includeRowPayloads: false,
          includeRowHashes: true,
          rowPage: 0,
          rowPageSize: 0
        }
      }));
      await disposeBridgeDaemonPool();
      observations.push(await observeRead({
        profile,
        paramPath,
        fileBytes,
        mode: 'legacy-full-document',
        commandOptions: { rowPage: 0, rowPageSize: FIRST_PAGE_SIZE }
      }));
      await disposeBridgeDaemonPool();
    }

    console.log(JSON.stringify({
      ok: true,
      probe: 'param-first-bad-cold-open',
      sourceBnd,
      firstPageSize: FIRST_PAGE_SIZE,
      profiles: observations,
      nonClaim: [
        'lazy-index 的 fileBytes 仍包含 Bridge 当前实现的 File.ReadAllBytes/SHA-256 成本；本 probe 只证明没有进入 ParamNativeDocument.Read/VerifyRoundTrip。',
        'legacy-full-document 是对照路径，不是当前 renderer 首屏契约。',
        '这是真实 Bridge 对已解析样本的 timing/telemetry 观察，不等同于 Electron UI PASS 或 release Gate PASS。'
      ]
    }, null, 2));
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

async function observeRead(input: {
  profile: (typeof PROBE_PROFILES)[number];
  paramPath: string;
  fileBytes: number;
  mode: TimingObservation['mode'];
  commandOptions: Record<string, unknown>;
}): Promise<TimingObservation> {
  const requestStartMs = performance.now();
  const requestStart = new Date().toISOString();
  const read = await runBridge<ParamReadData>({
    command: 'read-param-document',
    filePath: input.paramPath,
    allowedRoots: [dirname(input.paramPath)],
    timeoutMs: 120_000,
    commandOptions: input.commandOptions
  });
  const responseReadyMs = performance.now();
  const responseReady = new Date().toISOString();
  const data = read.data;
  const rows = data?.rows ?? [];
  const payloadRows = rows.filter((row) => typeof row.dataBase64 === 'string');
  const payloadBytesReturned = payloadRows.reduce(
    (total, row) => total + Buffer.from(row.dataBase64!, 'base64').byteLength,
    0
  );
  const telemetry = data?.telemetry ?? {};
  const nativeFullParseCount = numberOrNull(telemetry.paramParse);
  const declaredRowCount = numberOrNull(data?.rowCount);
  const decodedRowCountBeforeFirstRows = input.mode === 'lazy-index'
    ? numberOrNull(telemetry.paramDecodedRows) ?? 0
    : nativeFullParseCount !== null && nativeFullParseCount > 0
      ? declaredRowCount
      : null;
  const offscreenRowsMaterialized = input.mode === 'lazy-index'
    ? false
    : nativeFullParseCount !== null && nativeFullParseCount > 0;
  const diagnosticCodes = read.diagnostics.map((diagnostic) => diagnostic.code);
  const status = read.parseStatus === 'failed' ? 'failed' : 'ready';

  return {
    profile: input.profile.label,
    entryIndex: input.profile.entryIndex,
    mode: input.mode,
    fileBytes: input.fileBytes,
    expectedType: input.profile.expectedType,
    actualType: data?.typeName ?? null,
    requestStart,
    responseReady,
    elapsedMs: roundMs(responseReadyMs - requestStartMs),
    declaredRowCount,
    rowDataSize: numberOrNull(data?.rowDataSize),
    returnedRowCount: rows.length,
    payloadRowsReturned: payloadRows.length,
    payloadBytesReturned,
    decodedRowCountBeforeFirstRows,
    offscreenRowsMaterialized,
    nativeFullParseCount,
    telemetryDelta: {
      paramParse: telemetry.paramParse ?? 0,
      paramDecodedRows: telemetry.paramDecodedRows ?? 0,
      paramSessionOpen: telemetry.paramSessionOpen ?? 0,
      paramStructuralValidation: telemetry.paramStructuralValidation ?? 0,
      paramSerializedRows: telemetry.paramSerializedRows ?? 0
    },
    diagnosticCodes,
    evidence: input.mode === 'lazy-index'
      ? `status=${status}; PARAM_INDEX_READY=${diagnosticCodes.includes('PARAM_INDEX_READY')}; `
        + `paramDecodedRows=${telemetry.paramDecodedRows ?? 0}; `
        + '首屏前未 materialize 行 payload。'
      : `status=${status}; PARAM_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED=${diagnosticCodes.includes('PARAM_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED')}; `
        + `nativeFullParseCount=${nativeFullParseCount ?? 'unknown'}; `
        + 'full document path 在返回首屏前构造全部行；decodedRowCount 是声明行数推导，不能与 ParamDecodedRowsCount 混同。'
  };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
