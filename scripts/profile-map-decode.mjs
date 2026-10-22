import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Each option requires a value');
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.bridge || !options.input || !options.model || !options.out) {
  throw new Error('Usage: node scripts/profile-map-decode.mjs --bridge <executable> --input <resource> --model <model> --out <owned-directory> [--bridge-args <JSON-array>] [--repeat <1..20>]');
}
const repeat = Number(options.repeat ?? 3);
assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 20);
const executable = resolve(options.bridge), input = resolve(options.input), output = resolve(options.out);
const bridgeArgs = options['bridge-args'] ? JSON.parse(options['bridge-args']) : ['daemon'];
assert.ok(Array.isArray(bridgeArgs) && bridgeArgs.every(a => typeof a === 'string'));
const hashFile = async path => {
  const h = createHash('sha256');
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest('hex');
};
const sourceHash = await hashFile(input), executableHash = await hashFile(executable);
const bridgeFileInputs = [];
for (const argument of bridgeArgs) {
  const path = resolve(argument);
  try { if ((await stat(path)).isFile()) bridgeFileInputs.push({ path, sha256: await hashFile(path) }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(output, { recursive: true });
const report = { schema: 1, startedAt: new Date().toISOString(), executable, executableHash,
  bridgeArgs, bridgeFileInputs, input, sourceHash, model: options.model, effectiveConcurrency: 2,
  models: [], nativeMemory: [], driverMemory: [], processErrors: [], controls: [],
  scope: { driver: 'Node decoder caller, not Electron main', native: 'Production MAP decode and wire projection', gpu: 'not_run' } };
let counter = 0, currentStage = 'startup', child;
const pending = new Map(), workspaceSessionId = `map-profile-${process.pid}-${Date.now()}`;
const requests = [], stderr = [];
const write = frame => child.stdin.write(JSON.stringify({ protocolVersion: '1.0.0', workspaceSessionId, ...frame }) + '\n');
const call = (kind, payload) => {
  const requestId = `map-profile-${++counter}`, started = performance.now();
  let resolveStarted;
  const startedPromise = new Promise(resolve => { resolveStarted = resolve; });
  const promise = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`REQUEST_TIMEOUT:${requestId}`)); }, 120_000);
    pending.set(requestId, { resolveResult, reject, timer, started, events: [], resolveStarted });
  });
  write({ kind, requestId, payload });
  return { requestId, promise, startedPromise };
};
const request = async (command, commandOptions = {}) => {
  const response = await call('request', { command, filePath: input, priority: 'foreground', options: commandOptions }).promise;
  const result = response.frame.payload?.result;
  if (!result) throw new Error(`NATIVE_TERMINAL:${JSON.stringify(response.frame)}`);
  return { ...response, result };
};
const materialize = async result => {
  const artifact = result.data?.fileBacked;
  if (!artifact) return result;
  const pieces = [];
  for (let offset = 0; offset < artifact.byteLength;) {
    const { result: chunk } = await request('read-bridge-artifact', { artifactToken: artifact.artifactToken,
      offset, length: Math.min(artifact.chunkSize, artifact.byteLength - offset) });
    const data = chunk.data;
    assert.equal(data.offset, offset);
    const bytes = Buffer.from(data.dataBase64, 'base64');
    assert.equal(bytes.length, data.length); assert.ok(bytes.length > 0);
    pieces.push(bytes); offset += bytes.length;
  }
  const bytes = Buffer.concat(pieces); assert.equal(bytes.length, artifact.byteLength);
  return JSON.parse(bytes.toString('utf8'));
};
const readModel = async (round, priorSession = null) => {
  currentStage = `decode-${round}`;
  const started = performance.now(), h = createHash('sha256');
  let sessionToken = priorSession, cursor = null, complete = false;
  const pages = [], meshes = new Set(); let vertices = 0, indices = 0, triangles = 0;
  for (let page = 0; page < 256 && !complete; page++) {
    const response = await request('read-map-static-geometry', { modelName: options.model,
      sessionToken: sessionToken ?? '', cursor: cursor ?? '', ownerLeaseId: workspaceSessionId,
      diagnosticTimings: true });
    const result = await materialize(response.result), data = result.data ?? {};
    if (result.parseStatus === 'failed') {
      const unavailable = result.diagnostics?.some(d => d.code === 'MAPBND_KRAK_OODLE_UNAVAILABLE');
      if (!unavailable) throw new Error(`MAP_DECODE_FAILED:${JSON.stringify(result.diagnostics)}`);
      return { round, status: 'unavailable', wallMs: performance.now() - started,
        diagnostics: result.diagnostics, pages, sessionToken: null };
    }
    for (const chunk of data.chunks ?? []) {
      meshes.add(chunk.meshIndex); vertices += chunk.emittedVertexCount ?? 0;
      indices += chunk.emittedIndexCount ?? 0; triangles += chunk.triangleCount ?? 0;
      for (const field of ['positionsBase64', 'normalsBase64', 'uvsBase64', 'indicesBase64', 'sourceVertexIndicesBase64']) {
        h.update(field); if (chunk[field]) h.update(Buffer.from(chunk[field], 'base64'));
      }
    }
    pages.push({ page, wallMs: response.wallMs, wireBytes: response.wireBytes,
      chunkCount: data.chunks?.length ?? 0, telemetry: data.telemetry,
      nativeTiming: result.diagnostics?.find(d => d.code === 'MAP_NATIVE_TIMINGS')?.details,
      cache: result.diagnostics?.find(d => d.code === 'MAP_RESOURCE_CACHE_SNAPSHOT')?.details });
    sessionToken = data.sessionToken ?? sessionToken;
    assert.ok(data.nextCursor !== cursor || data.complete === true, 'Repeated non-terminal MAP cursor');
    cursor = data.nextCursor; complete = data.complete === true;
    if (!complete) assert.ok(sessionToken && cursor, 'Incomplete MAP without session/cursor');
  }
  assert.equal(complete, true, 'MAP page limit reached');
  return { round, status: meshes.size ? 'decoded' : 'empty_or_unclassified', wallMs: performance.now() - started,
    pageCount: pages.length, meshes: meshes.size, vertices, indices, triangles,
    geometrySha256: h.digest('hex'), sessionToken, pages };
};
let sampler;
try {
  child = spawn(executable, bridgeArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', error => { for (const p of pending.values()) p.reject(error); });
  createInterface({ input: child.stdout }).on('line', line => {
    let frame;
    try { frame = JSON.parse(line); } catch (error) { for (const p of pending.values()) p.reject(error); return; }
    const p = pending.get(frame.requestId);
    if (!p) return;
    if (frame.kind === 'progress' || frame.kind === 'request/accepted') {
      p.events.push({ kind: frame.kind, payload: frame.payload, at: performance.now() });
      if (frame.kind === 'progress' && frame.payload.phase === 'started') p.resolveStarted();
      return;
    }
    clearTimeout(p.timer); pending.delete(frame.requestId);
    const response = { frame, wallMs: performance.now() - p.started, wireBytes: Buffer.byteLength(line), events: p.events };
    requests.push({ requestId: frame.requestId, kind: frame.kind, wallMs: response.wallMs });
    p.resolveResult(response);
  });
  createInterface({ input: child.stderr }).on('line', line => {
    if (line.startsWith('[SF_MAP_PROFILE_MEMORY] ')) report.nativeMemory.push(JSON.parse(line.slice(24)));
    else if (line.startsWith('[SF_MAP_PROFILE_PRODUCER] ')) report.nativeProducer = JSON.parse(line.slice(26));
    else stderr.push(line);
  });
  sampler = setInterval(async () => {
    let nativeRssKiB = null;
    if (process.platform === 'linux') {
      try { const status = await readFile(`/proc/${child.pid}/status`, 'utf8'); nativeRssKiB = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0); } catch { /* Child may have exited. */ }
    }
    report.driverMemory.push({ stage: currentStage, at: performance.now(), memory: process.memoryUsage(), nativeRssKiB });
  }, 25);
  const handshake = await call('handshake', { allowedRoots: [dirname(input)], writableRoots: [], maxConcurrency: 2 }).promise;
  assert.equal(handshake.frame.kind, 'handshake'); assert.equal(handshake.frame.payload.maxConcurrency, 2);
  report.handshake = handshake.frame.payload;
  let session = null;
  for (let round = 0; round < repeat; round++) {
    const row = await readModel(round, session); report.models.push(row); session = row.sessionToken;
    console.log(JSON.stringify({ round, status: row.status, wallMs: row.wallMs, pages: row.pageCount,
      vertices: row.vertices, triangles: row.triangles }));
    if (row.status === 'unavailable') break;
    if (round) assert.equal(row.geometrySha256, report.models[0].geometrySha256, 'Repeated geometry changed');
  }
  if (options.controls === 'true' && report.models[0]?.status === 'decoded') {
    currentStage = 'concurrent-pair';
    const payload = { command: 'read-map-static-geometry', filePath: input, priority: 'foreground',
      options: { modelName: options.model, sessionToken: session, ownerLeaseId: workspaceSessionId,
        cursor: '', diagnosticTimings: true } };
    const pairStarted = performance.now();
    const pair = [call('request', payload), call('request', payload)];
    const pairHealth = (await call('health', {}).promise).frame.payload;
    const pairResults = await Promise.all(pair.map(p => p.promise));
    assert.ok(pairResults.every(r => r.frame.kind === 'result' && r.frame.payload.result.parseStatus !== 'failed'));
    const intervals = pairResults.map(r => ({
      started: r.events.find(e => e.kind === 'progress' && e.payload.phase === 'started')?.at,
      completed: r.events.find(e => e.kind === 'progress' && e.payload.phase === 'completed')?.at
    }));
    const overlapObserved = pairHealth.activeRequests === 2 || (intervals.every(i => Number.isFinite(i.started) && Number.isFinite(i.completed))
      && Math.max(...intervals.map(i => i.started)) < Math.min(...intervals.map(i => i.completed)));
    report.controls.push({ kind: 'two-concurrent-native-requests', status: overlapObserved ? 'passed' : 'not_observed',
      effectiveConcurrency: 2, wallMs: performance.now() - pairStarted, healthDuring: pairHealth,
      overlapObserved, intervals,
      responses: pairResults.map(r => ({ wallMs: r.wallMs, events: r.events,
        chunkCount: r.frame.payload.result.data?.chunks?.length })) });

    currentStage = 'cancel';
    const blockers = [call('request', payload), call('request', payload)];
    const target = call('request', payload);
    const cancelSent = performance.now();
    write({ kind: 'cancel', requestId: `cancel-${++counter}`, payload: { targetRequestId: target.requestId } });
    const terminal = await target.promise;
    const afterCancelMs = performance.now() - cancelSent;
    await Promise.all(blockers.map(p => p.promise));
    const cancelled = terminal.frame.kind === 'cancelled';
    const queuedObserved = !terminal.events.some(e => e.kind === 'progress' && e.payload.phase === 'started');
    report.controls.push({ kind: 'queued-native-request-cancellation', status: cancelled && queuedObserved ? 'passed' : 'not_observed',
      terminalKind: terminal.frame.kind, terminal: terminal.frame.payload,
      afterCancelMs, queuedObserved, events: terminal.events,
      partialGeometryPublished: terminal.frame.kind === 'result' });
    assert.equal(cancelled, true, 'Cancellation must have a structured cancelled terminal without geometry publication');

    currentStage = 'reopen-after-cancel';
    const reopened = await readModel('reopen', null);
    assert.equal(reopened.geometrySha256, report.models[0].geometrySha256);
    report.controls.push({ kind: 'reopen-after-cancel', status: 'passed', model: reopened });
  }
  currentStage = 'close';
  report.healthBeforeClose = (await call('health', {}).promise).frame.payload;
  report.close = (await call('workspace/close', {}).promise).frame;
  assert.equal(report.close.kind, 'workspace/closed');
  child.stdin.end();
  report.processExit = await new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })));
  assert.equal(report.processExit.code, 0);
  if (report.nativeMemory.length) {
    const released = report.nativeMemory.find(s => s.stage === 'after-release-collection');
    assert.ok(released, 'Profiler must report its terminal release sample');
    assert.ok(released.cache, 'Profiler must retain the actual detached cache snapshot');
    assert.equal(released.cacheAttached, false);
    assert.equal(released.cache.state, 'disposed');
    assert.equal(released.cache.entryCount, 0); assert.equal(released.cache.readyBytes, 0);
    assert.equal(released.cache.inFlightBytes, 0);
    report.controls.push({ kind: 'daemon-close-releases-native-resources', status: 'passed', sample: released });
  }
  report.status = report.models.every(m => m.status === 'decoded') ? 'decoded' : 'partial';
} catch (error) {
  report.status = 'failed'; report.failure = { stage: currentStage, message: error.message };
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  for (const p of pending.values()) clearTimeout(p.timer);
  child?.kill(); report.requests = requests; report.stderr = stderr;
  report.sourceHashAfter = await hashFile(input); assert.equal(report.sourceHashAfter, sourceHash);
  report.executableHashAfter = await hashFile(executable); assert.equal(report.executableHashAfter, executableHash);
  for (const item of bridgeFileInputs) {
    item.sha256After = await hashFile(item.path); assert.equal(item.sha256After, item.sha256, 'Producer/helper input changed during capture');
  }
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'map-decode-profile.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: join(output, 'map-decode-profile.json') }));
}
