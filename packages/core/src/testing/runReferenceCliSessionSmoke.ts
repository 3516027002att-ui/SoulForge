/**
 * CLI session smoke: param adapter shapes, batch dependency skip, no credentials on stdout.
 *
 * Prefers packages/core/src/cli/* production modules. Missing modules/symbols
 * fail closed with `behavior_not_implemented: <symbol>`.
 */
import { pathToFileURL } from 'node:url';
import { createFixtureNativePorts } from './referenceOptimizationFixtures.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

function failMissing(symbol: string): never {
  const message = `behavior_not_implemented: ${symbol}`;
  console.error(JSON.stringify({ ok: false, code: 'BEHAVIOR_NOT_IMPLEMENTED', symbol, message, checks }, null, 2));
  process.exitCode = 1;
  throw new Error(message);
}

type DynamicModule = Record<string, unknown>;

async function loadModule(specifier: string): Promise<DynamicModule | null> {
  try {
    return (await import(specifier)) as DynamicModule;
  } catch {
    return null;
  }
}

function requireFn(mod: DynamicModule | null, name: string): (...args: unknown[]) => unknown {
  if (!mod) failMissing(name);
  const value = mod[name];
  if (typeof value !== 'function') failMissing(name);
  return value as (...args: unknown[]) => unknown;
}

async function testAdapterParamShapes(adapterMod: DynamicModule | null): Promise<void> {
  const parseNativeCommand = requireFn(adapterMod, 'parseNativeCommand');

  const read = parseNativeCommand([
    'param', 'read',
    '--table', 'FixtureNpcParam',
    '--row-id', '91000100',
    '--field', 'hp,stamina'
  ]) as { ok: boolean; tool?: string; args?: Record<string, unknown> };

  const readShapeOk = read.ok === true
    && read.tool === 'read_param_fields'
    && Array.isArray((read.args as { rowIds?: unknown }).rowIds)
    && ((read.args as { rowIds: number[] }).rowIds[0] === 91000100)
    && Array.isArray((read.args as { fieldIds?: unknown }).fieldIds)
    && (read.args as { fieldIds: string[] }).fieldIds.includes('hp')
    && (read.args as { table?: string }).table === 'FixtureNpcParam';
  record(
    'adapter_maps_param_read_to_read_param_fields',
    readShapeOk,
    JSON.stringify(read)
  );

  const set = parseNativeCommand([
    'param', 'set',
    '--set', 'FixtureNpcParam#91000100.hp=900'
  ]) as { ok: boolean; tool?: string; args?: Record<string, unknown> };

  const edits = (set.args as { edits?: Array<Record<string, unknown>> } | undefined)?.edits ?? [];
  const setShapeOk = set.ok === true
    && set.tool === 'mutate_param_fields'
    && edits.length === 1
    && edits[0]?.table === 'FixtureNpcParam'
    && edits[0]?.rowId === 91000100
    && edits[0]?.fieldId === 'hp'
    && edits[0]?.value === 900;
  record(
    'adapter_maps_param_set_to_mutate_param_fields',
    setShapeOk,
    JSON.stringify(set)
  );
}

async function testBatchDependencySkip(dispatchMod: DynamicModule | null): Promise<void> {
  const dispatchBatch = requireFn(dispatchMod, 'dispatchBatch');
  const validateBatchFile = requireFn(dispatchMod, 'validateBatchFile');
  const ports = createFixtureNativePorts();

  const validated = validateBatchFile([
    { id: 'a-read', tool: 'read_param_fields', args: { table: 'FixtureNpcParam', rowIds: [1], fieldIds: ['hp'] } },
    { id: 'b-mutate', tool: 'mutate_param_fields', args: { edits: [] }, dependsOn: ['a-read'] },
    { id: 'c-followup', tool: 'read_param_fields', args: { table: 'FixtureNpcParam', rowIds: [1], fieldIds: ['hp'] }, dependsOn: ['b-mutate'] }
  ]) as { ok: boolean; items?: Array<{ id: string; tool: string }>; code?: string };

  if (!validated.ok) {
    record('batch_dependency_failure_skips_dependents', false, `validate failed: ${JSON.stringify(validated)}`);
    return;
  }

  const executed: string[] = [];
  const result = await dispatchBatch({
    items: validated.items as unknown as Array<{ id: string; tool: string; args: Record<string, unknown>; dependsOn?: string[] }>,
    continueOnError: false,
    port: {
      execute: async (tool: string, args: Record<string, unknown>) => {
        executed.push(tool);
        ports.providerPorts.readParamFields(args).catch(() => undefined);
        // First mutation fails — dependents must be skipped without writer calls.
        if (tool === 'mutate_param_fields') {
          return {
            ok: false,
            error: { code: 'NATIVE_READ_REQUIRED', message: 'fixture batch dependency failure' }
          };
        }
        return { ok: true, data: { fixture: true } };
      }
    }
  }) as {
    ok: boolean;
    items: Array<{ id: string; status: string; error?: { code?: string } }>;
    summary: Record<string, number>;
  };

  const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
  const skipOk = byId['b-mutate']?.status === 'failed'
    && byId['c-followup']?.status === 'skipped_dependency'
    && executed.filter((t) => t === 'mutate_param_fields').length === 1;
  record(
    'batch_dependency_failure_skips_dependents',
    skipOk,
    JSON.stringify({
      statuses: Object.fromEntries(result.items.map((i) => [i.id, i.status])),
      executed,
      summary: result.summary
    })
  );
}

async function testNoCredentialsInStdout(hostMod: DynamicModule | null, clientMod: DynamicModule | null): Promise<void> {
  const createLocalSessionHost = requireFn(hostMod, 'createLocalSessionHost');
  const createLocalSessionClient = requireFn(clientMod, 'createLocalSessionClient');
  const mintSessionToken = requireFn(clientMod, 'mintSessionToken');

  const secretToken = String(mintSessionToken());
  const apiKey = 'fixture-sk-should-never-appear-on-stdout';

  const host = createLocalSessionHost({
    sessionKey: 'fixture-session-key',
    execute: async (tool: string) => ({
      ok: true,
      data: { tool, fieldValues: { hp: 800 } },
      // Host must not echo credentials into tool results.
      credentials: undefined
    })
  }) as { handleRequest: (request: unknown) => Promise<unknown>; close: () => void };

  const client = createLocalSessionClient({
    sessionKey: 'fixture-session-key',
    token: secretToken,
    send: async (frame: unknown) => {
      const request = frame as { id: string; tool: string; args: Record<string, unknown>; auth?: string };
      // Auth rides the request channel; protocol result on stdout must not include it.
      const result = await host.handleRequest({
        id: request.id,
        tool: request.tool,
        args: request.args
      });
      return result;
    }
  }) as { call: (tool: string, args: Record<string, unknown>) => Promise<unknown> };

  const result = await client.call('read_param_fields', {
    table: 'FixtureNpcParam',
    rowIds: [91000100],
    fieldIds: ['hp']
  });
  const stdoutPayload = JSON.stringify(result);
  host.close();

  const leakedToken = stdoutPayload.includes(secretToken);
  const leakedApiKey = stdoutPayload.includes(apiKey) || stdoutPayload.toLowerCase().includes('sk-should');
  record(
    'no_credentials_in_stdout_protocol_result',
    !leakedToken && !leakedApiKey,
    JSON.stringify({ leakedToken, leakedApiKey, payloadKeys: Object.keys((result ?? {}) as object) })
  );
}

export async function runReferenceCliSessionSmoke(): Promise<void> {
  const adapterMod = await loadModule('../cli/nativeCommandAdapter.js');
  const dispatchMod = await loadModule('../cli/batchDispatcher.js');
  const hostMod = await loadModule('../cli/localSessionHost.js');
  const clientMod = await loadModule('../cli/localSessionClient.js');

  if (!adapterMod && !dispatchMod && !hostMod) {
    failMissing('packages/core/src/cli/*');
  }

  // Required production symbols — missing any one fails closed.
  requireFn(adapterMod, 'parseNativeCommand');
  requireFn(dispatchMod, 'dispatchBatch');
  requireFn(dispatchMod, 'validateBatchFile');
  requireFn(hostMod, 'createLocalSessionHost');
  requireFn(clientMod, 'createLocalSessionClient');
  requireFn(clientMod, 'mintSessionToken');

  await testAdapterParamShapes(adapterMod);
  await testBatchDependencySkip(dispatchMod);
  await testNoCredentialsInStdout(hostMod, clientMod);

  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    smoke: 'reference-cli-session',
    checks,
    failedCount: failed.length
  }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReferenceCliSessionSmoke().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('behavior_not_implemented:')) {
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
