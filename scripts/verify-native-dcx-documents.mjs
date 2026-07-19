import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  loadNativeFixtureRegistry,
  NativeFixtureRegistryError
} from './native-fixture-registry.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryInput = process.argv[2]
  ?? process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim()
  ?? '';
const fixtureRootInput = process.argv[3]
  ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  ?? '';
const executable = resolve(
  repoRoot,
  'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
);
const evidenceLimit = 20;

if (!registryInput || !fixtureRootInput) {
  abort(
    'DCX_CORPUS_REGISTRY_ENVIRONMENT_REQUIRED',
    'DCX corpus 要求同时提供私有 registry 与 fixture root；不允许扫描目录自动挑选文件。',
    undefined,
    2
  );
}

let corpus;
try {
  corpus = await collectCorpus();
} catch (error) {
  const known = error instanceof NativeFixtureRegistryError || error instanceof DcxVerifierError;
  abort(
    known ? error.code : 'DCX_CORPUS_LOAD_FAILED',
    known ? error.message : 'DCX corpus 加载发生未预期错误。',
    known && 'fixtureId' in error ? error.fixtureId : undefined
  );
}

const variants = new Map();
const failures = [];
const fixtureEvidence = [];
let dfltVerified = 0;
let krakVerified = 0;
let krakBlocked = 0;
let nestedBnd4Verified = 0;
let nestedBnd4Entries = 0;

for (const fixture of corpus.fixtures) {
  try {
    const { stdout } = await execFileAsync(executable, ['read-dcx-document', fixture.absolutePath], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000
    });
    const result = JSON.parse(stdout);
    const data = result.data;
    const sourceHashMatches = !fixture.sha256 || data?.sourceHash === fixture.sha256;
    const declaredFormatMatches = !fixture.declaredFormat
      || fixture.declaredFormat === `DCX-${data?.compressionFormat}`;
    const dfltOk = data?.compressionFormat === 'DFLT'
      && data.roundTrip?.payloadIdentical === true
      && data.roundTrip?.variantIdentical === true;
    const krakOk = data?.compressionFormat === 'KRAK'
      && /^[a-f0-9]{64}$/.test(data.payloadHash ?? '')
      && data.uncompressedSize > 0;

    if (!sourceHashMatches || !declaredFormatMatches) {
      failures.push(evidence(fixture, data, [
        {
          code: !sourceHashMatches ? 'DCX_SOURCE_HASH_CHANGED' : 'DCX_DECLARED_FORMAT_MISMATCH'
        }
      ]));
      continue;
    }

    if (dfltOk || krakOk) {
      if (dfltOk) dfltVerified += 1;
      else krakVerified += 1;
      variants.set(data.variant, (variants.get(data.variant) ?? 0) + 1);

      const assertions = [
        ...fixture.assertions,
        'source-hash-verified',
        dfltOk ? 'dflt-byte-roundtrip' : 'krak-decompression-complete'
      ];
      const diagnostics = [];
      if (data.nested?.format === 'BND4' && data.nested?.roundTrip?.entriesIdentical === true) {
        if (data.nested?.crud?.allPassed !== true
          || (dfltOk && data.nestedDcxRebuildVerified !== true)) {
          failures.push(evidence(fixture, data, [{ code: 'BND4_CRUD_ROUNDTRIP_FAILED' }]));
          continue;
        }
        nestedBnd4Verified += 1;
        nestedBnd4Entries += data.nested.entryCount;
        assertions.push('nested-bnd4-crud-roundtrip');
      }
      fixtureEvidence.push(evidence(fixture, data, diagnostics, assertions));
    } else {
      failures.push(evidence(fixture, data, diagnosticCodes(result, 'UNEXPECTED_RESULT')));
    }
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      result = undefined;
    }
    const diagnosticMessage = result?.diagnostics?.[0]?.message ?? String(error);
    if ((fixture.declaredFormat === 'DCX-KRAK' || !fixture.declaredFormat)
      && /Oodle|KRAK|运行库/.test(diagnosticMessage)) {
      krakBlocked += 1;
      fixtureEvidence.push(evidence(fixture, undefined, [{ code: 'KRAK_RUNTIME_BLOCKED' }]));
    } else {
      failures.push(evidence(fixture, undefined, diagnosticCodes(result, 'PROCESS_FAILED')));
    }
  }
}

const status = dfltVerified === 0 || failures.length > 0
  ? 'failed'
  : krakBlocked > 0
    ? 'blocked'
    : 'passed';
const reportedEvidence = selectEvidence(fixtureEvidence, evidenceLimit);
const report = {
  ok: status === 'passed',
  status,
  message: status === 'passed'
    ? '真实 DCX corpus 完整读取与 DFLT/KRAK payload 验证通过'
    : status === 'blocked'
      ? 'DFLT 验证通过，但 KRAK 因合法 Oodle runtime 缺失而 blocked'
      : '真实 DCX corpus 验证失败',
  files: corpus.fixtures.length,
  dfltVerified,
  krakVerified,
  krakBlocked,
  nestedBnd4Verified,
  nestedBnd4Entries,
  variants: Object.fromEntries([...variants].sort()),
  fixtureEvidence: reportedEvidence,
  fixtureEvidenceTruncated: fixtureEvidence.length > reportedEvidence.length,
  failuresCount: failures.length,
  failures: failures.slice(0, evidenceLimit),
  failuresTruncated: failures.length > evidenceLimit
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;

async function collectCorpus() {
  const registry = await loadNativeFixtureRegistry({
    registryPath: registryInput,
    fixtureRoot: fixtureRootInput
  });
  const registered = registry.fixtures.filter((fixture) =>
    fixture.expectedAssertions.includes('dcx-document'));
  const missingFormats = ['DCX-DFLT', 'DCX-KRAK'].filter((format) =>
    !registered.some((fixture) => fixture.format === format));
  if (missingFormats.length > 0) {
    throw new DcxVerifierError(
      'DCX_REGISTERED_CORPUS_INCOMPLETE',
      '严格 registry 必须同时登记 DFLT 与 KRAK 的 dcx-document fixture。'
    );
  }
  return {
    fixtures: registered.map((fixture) => ({
      absolutePath: fixture.absolutePath,
      fixtureId: fixture.fixtureId,
      sha256: fixture.actualSha256,
      variant: fixture.variant,
      assertions: fixture.expectedAssertions,
      declaredFormat: fixture.format
    }))
  };
}

function evidence(fixture, data, diagnostics = [], extraAssertions = undefined) {
  return {
    fixtureId: fixture.fixtureId,
    ...(fixture.sha256 || data?.sourceHash ? { sha256: fixture.sha256 ?? data.sourceHash } : {}),
    variant: fixture.variant,
    assertions: [...new Set(extraAssertions ?? fixture.assertions)],
    diagnostics
  };
}

function diagnosticCodes(report, fallback) {
  if (!Array.isArray(report?.diagnostics) || report.diagnostics.length === 0) {
    return [{ code: fallback }];
  }
  return report.diagnostics.slice(0, 50).map((diagnostic) => ({
    code: typeof diagnostic?.code === 'string' ? diagnostic.code : fallback,
    ...(typeof diagnostic?.severity === 'string' ? { severity: diagnostic.severity } : {})
  }));
}

function selectEvidence(items, limit) {
  const diagnosticItems = items.filter((item) => item.diagnostics.length > 0);
  const selected = diagnosticItems.slice(0, Math.ceil(limit / 2));
  for (const item of items) {
    if (selected.length >= limit) break;
    if (!selected.includes(item)) selected.push(item);
  }
  return selected;
}

function abort(code, message, fixtureId = undefined, exitCode = 1) {
  console.log(JSON.stringify({
    ok: false,
    status: 'failed',
    message,
    failuresCount: 1,
    failures: [{
      ...(fixtureId ? { fixtureId } : {}),
      assertions: ['dcx-document'],
      diagnostics: [{ code }]
    }]
  }, null, 2));
  process.exit(exitCode);
}

class DcxVerifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DcxVerifierError';
    this.code = code;
  }
}
