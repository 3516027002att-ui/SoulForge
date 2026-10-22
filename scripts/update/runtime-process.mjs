/** Process integration of the production release client/transport/state machine.
 * The loopback release corpus and downloader/installer ports are test-owned;
 * this does not execute NSIS or establish GitHub availability/desktop IPC. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const REQUIRED_RUNTIME_CASES = Object.freeze(['runtime-check-download', 'runtime-duplicate-requests',
  'runtime-cancel-late-download', 'runtime-hash-rejection', 'runtime-transport-bounds', 'runtime-install-port']);
const entrypoint = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

export async function runRuntimeProbe({ repositoryRoot, evidenceRoot, runId, headSha }) {
  await mkdir(evidenceRoot, { recursive: true });
  const sourceFiles = ['githubReleaseClient.ts', 'httpTransport.ts', 'updateStateMachine.ts', 'types.ts'];
  const sourceHashes = {};
  for (const name of sourceFiles) sourceHashes[name] = sha256(await readFile(join(repositoryRoot, 'apps/desktop/src/main/update', name)));
  const bundlePath = join(evidenceRoot, 'production-update-core.mjs');
  await build({ stdin: { contents: "export {GitHubReleaseClient,sha256Hex,sha512Base64} from './githubReleaseClient.ts'; export {createGitHubFetchTransport} from './httpTransport.ts'; export {UpdateStateMachine} from './updateStateMachine.ts';",
    resolveDir: join(repositoryRoot, 'apps/desktop/src/main/update'), sourcefile: 'update-process-entry.mjs' },
    outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { GitHubReleaseClient, createGitHubFetchTransport, UpdateStateMachine, sha512Base64 } = await import(pathToFileURL(bundlePath).href);
  const bytes = Buffer.from('bounded update process corpus');
  const installer = 'SoulForge-0.9.2-x64.exe', base = 'https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2/';
  const latest = `version: 0.9.2\nfiles:\n  - url: ${installer}\n    sha512: ${sha512Base64(bytes)}\n    size: ${bytes.length}\npath: ${installer}\nsha512: ${sha512Base64(bytes)}\n`;
  const corpus = new Map([[installer, bytes], ['latest.yml', Buffer.from(latest)], ['SHA256SUMS.txt', Buffer.from(`${sha256(bytes)}  ${installer}\n`)], [`${installer}.blockmap`, Buffer.from('bounded blockmap descriptor')]]);
  const release = { tag_name: 'v0.9.2', draft: false, prerelease: false, html_url: 'https://github.com/3516027002att-ui/SoulForge/releases/tag/v0.9.2',
    assets: [...corpus].map(([name, value]) => ({ name, size: value.length, state: 'uploaded', browser_download_url: base + name })) };
  let httpRequests = 0, installerPortCalls = 0;
  const server = createServer((request, response) => {
    httpRequests++;
    const logical = new URL(request.url, 'http://127.0.0.1').searchParams.get('url');
    const url = new URL(logical);
    if (url.pathname === '/timeout') return; // the production transport must abort this socket
    if (url.pathname === '/oversize') { response.writeHead(200, { 'content-length': 1000 }); response.end('bounded'); return; }
    const body = url.hostname === 'api.github.com' ? Buffer.from(JSON.stringify([release])) : corpus.get(url.pathname.split('/').at(-1));
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-length': body.length }); response.end(body);
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Only the external transport is redirected to the owned server. Production
  // URL approval, metadata parsing and state transitions execute unchanged.
  const fetchImpl = async (url, init) => {
    const response = await fetch(`${origin}/?url=${encodeURIComponent(String(url))}`, init);
    Object.defineProperty(response, 'url', { value: String(url) }); // test-owned logical endpoint; body/socket are actual HTTP
    return response;
  };
  const transport = createGitHubFetchTransport({ fetchImpl, timeoutMs: 2000 });
  const createMachine = ({ held, entered, corrupt = false, installGate } = {}) => {
    const client = new GitHubReleaseClient({ currentVersion: '0.9.1', platform: 'win32', arch: 'x64', transport });
    const tokens = new Map();
    return new UpdateStateMachine(client, {
      download: async ({ update, signal, onProgress }) => {
        const response = await transport.get(update.installerUrl, { signal });
        const downloaded = Buffer.from(response.body);
        if (corrupt) downloaded[0] ^= 1;
        onProgress({ downloadedBytes: downloaded.length, totalBytes: downloaded.length });
        entered?.resolve();
        if (held) await held.promise; // deliberately late port completion after cancellation
        const token = randomUUID(); tokens.set(token, downloaded);
        return { token, installerBytes: downloaded };
      }
    }, { install: async ({ token, update }) => {
      const body = tokens.get(token); assert.ok(body); tokens.delete(token);
      assert.equal(sha256(body), update.installerSha256); installerPortCalls++;
      if (installGate) await installGate.promise;
    } });
  };
  const cases = [];
  const check = async (id, assertions, execute) => { await execute(); cases.push({ id, status: 'passed', executed: true, evidenceLevel: 'process-integration', assertions, evidenceFiles: ['receipt.json'] }); };
  try {
    const held = deferred(), entered = deferred(), installGate = deferred();
    const machine = createMachine({ held, entered, installGate });
    await check('runtime-duplicate-requests', ['concurrent checks share one promise; second download returns UPDATE_BUSY'], async () => {
      const first = machine.check(), second = machine.check(); assert.equal(first, second); const checked = await first; assert.equal(checked.status, 'available', JSON.stringify(checked));
      const download = machine.download(); await entered.promise;
      assert.equal((await machine.download()).diagnostic.code, 'UPDATE_BUSY'); held.resolve(); assert.equal((await download).status, 'pending-install');
    });
    await check('runtime-check-download', ['production release metadata and both installer hashes accept actual HTTP bytes; public state excludes token/path'], async () => {
      assert.equal(machine.state.info.version, '0.9.2'); assert.equal(machine.state.info.installerSha256, sha256(bytes));
      assert.equal('token' in machine.state, false); assert.equal('installerPath' in machine.state.info, false);
    });
    await check('runtime-install-port', ['concurrent installation shares one promise and consumes one opaque token; NSIS is not invoked'], async () => {
      const first = machine.install(), second = machine.install(); assert.equal(first, second); installGate.resolve();
      assert.equal((await first).status, 'installed'); assert.equal(installerPortCalls, 1);
      assert.equal((await machine.install()).diagnostic.code, 'UPDATE_INVALID_STATE'); assert.equal(installerPortCalls, 1);
    });
    await check('runtime-cancel-late-download', ['late download completion cannot turn cancelled into pending-install or invoke the installer'], async () => {
      const held = deferred(), entered = deferred(), machine = createMachine({ held, entered }); await machine.check();
      const download = machine.download(); await entered.promise; assert.equal(machine.cancel().status, 'cancelled'); held.resolve();
      assert.equal((await download).status, 'cancelled'); assert.equal(machine.state.status, 'cancelled');
      assert.equal((await machine.install()).diagnostic.code, 'UPDATE_INVALID_STATE'); assert.equal(installerPortCalls, 1);
    });
    await check('runtime-hash-rejection', ['same-size changed HTTP download is rejected before the installer port'], async () => {
      const machine = createMachine({ corrupt: true }); await machine.check();
      assert.equal((await machine.download()).diagnostic.code, 'UPDATE_HASH_MISMATCH');
      assert.equal((await machine.install()).diagnostic.code, 'UPDATE_INVALID_STATE'); assert.equal(installerPortCalls, 1);
    });
    await check('runtime-transport-bounds', ['production transport rejects unapproved hosts, oversized HTTP body and stalled HTTP response'], async () => {
      await assert.rejects(() => transport.get('https://example.invalid/'), error => error.diagnostic.code === 'UPDATE_REDIRECT_FORBIDDEN');
      await assert.rejects(() => transport.get('https://github.com/oversize', { maxBytes: 10 }), error => error.diagnostic.code === 'UPDATE_RESPONSE_TOO_LARGE');
      const bounded = createGitHubFetchTransport({ fetchImpl, timeoutMs: 100 });
      await assert.rejects(() => bounded.get('https://github.com/timeout'), error => error.diagnostic.code === 'UPDATE_TIMEOUT');
    });
    const receipt = { runId, headSha, workerPid: process.pid, sourceHashes, bundleSha256: sha256(await readFile(bundlePath)), httpRequests, installerPortCalls,
      boundary: 'Actual Node process and loopback HTTP; production update core with test-owned downloader/installer ports. No NSIS, desktop IPC or public GitHub network.' };
    await writeFile(join(evidenceRoot, 'receipt.json'), JSON.stringify(receipt, null, 2));
    const artifacts = [];
    for (const relativePath of ['receipt.json', 'production-update-core.mjs']) { const value = await readFile(join(evidenceRoot, relativePath)); artifacts.push({ relativePath, bytes: value.length, sha256: sha256(value) }); }
    return { runId, headSha, entrypointSha256: sha256(await readFile(entrypoint)), status: 'passed', cases, artifacts,
      commands: [{ argv: [process.execPath, entrypoint, '--probe'], exitCode: 0, status: 'executed' }],
      untestedClaims: ['NSIS installation and desktop IPC', 'Public GitHub network and published releases', 'Application-initiated automatic update'] };
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/update/runtime-process.mjs <probe-input.json>');
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const report = await runRuntimeProbe(input);
    await writeFile(join(input.evidenceRoot, 'probe.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ status: report.status, cases: report.cases.length, workerPid: process.pid }) + '\n');
  } catch (error) { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; }
}
