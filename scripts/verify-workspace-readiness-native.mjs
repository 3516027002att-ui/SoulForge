/** Public Electron API cold-start probe; copies native PARAM/MSG, never writes source mods. */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { assertAgentProductionBuildFresh } from './agent-production-build-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = process.env.SOULFORGE_SEKIRO_ROOT ?? 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const source = process.env.SOULFORGE_SEKIRO_MOD_ROOT ?? join(game, 'mods');
const timeoutMs = Number(process.env.SOULFORGE_READINESS_TIMEOUT_MS ?? 180_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('Invalid bounded probe timeout');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const scratch = await mkdtemp(join(tmpdir(), 'soulforge-readiness-native-'));
const overlay = join(scratch, 'overlay');
const output = join(root, 'output/playwright', `workspace-readiness-${stamp}`);
await mkdir(output, { recursive: true });
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const bounded = (promise, ms, code) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })])
    .finally(() => clearTimeout(timer));
};
const started = Date.now();
const report = { ok: false, scope: 'cold PARAM/MSG workspace readiness and operation-history responsiveness',
  sourceModWrites: false, samples: [], history: { status: 'not-started' }, errors: [] };
let app;
try {
  report.build = (await assertAgentProductionBuildFresh(root)).manifest;
  for (const kind of ['param', 'msg']) await cp(join(source, kind), join(overlay, kind), { recursive: true });
  app = await electron.launch({ cwd: root,
    args: [join(root, 'apps/desktop/e2e/playwright/production-main.mjs'), `--user-data-dir=${join(scratch, 'user-data')}`],
    env: { ...process.env, NODE_ENV: 'production', SF_E2E_OVERLAY_ROOT: overlay, SF_E2E_BASE_ROOT: game,
      SOULFORGE_AGENT_TASK_RECORD_DIR: join(scratch, 'records') } });
  const child = app.process();
  report.pid = child.pid;
  report.stderrTail = '';
  child.stderr?.on('data', chunk => { report.stderrTail = (report.stderrTail + String(chunk)).slice(-8192); });
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule('inspector');
    const session = new Session();
    session.connect();
    const post = (method) => new Promise((resolveCall, rejectCall) => session.post(method,
      (error, result) => error ? rejectCall(error) : resolveCall(result)));
    await post('Profiler.enable');
    await post('Profiler.start');
    globalThis.__readinessProfiler = { session, post };
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.waitForFunction(() => Boolean(globalThis.soulforge), undefined, { timeout: 30000 });
  report.shellReadyMs = Date.now() - started;
  await page.screenshot({ path: join(output, 'shell.png') });
  report.scan = await bounded(page.evaluate(async () => {
    const api = globalThis.soulforge;
    const overlaySelection = await api.openWorkspaceDialog();
    const baseSelection = await api.openBaseDialog();
    const scan = await api.scanWorkspace({ overlaySelectionId: overlaySelection.selectionId,
      baseSelectionId: baseSelection.selectionId, game: 'sekiro' });
    globalThis.__readinessProbe = { status: 'running', startedAt: Date.now() };
    void api.analyzeWorkspace().then(result => {
      globalThis.__readinessProbe = { status: 'completed', elapsedMs: Date.now() - globalThis.__readinessProbe.startedAt,
        parsedFiles: result.parsedFiles, diagnostics: result.diagnostics, rag: result.rag };
    }, error => { globalThis.__readinessProbe = { status: 'failed', message: String(error) }; });
    return { fileCount: scan.files.length, countsByKind: scan.countsByKind };
  }), 45000, 'SCAN_TIMEOUT');
  report.scanReadyMs = Date.now() - started;
  let historyPromise;
  let lastLog = 0;
  while (Date.now() - started < timeoutMs) {
    const sampledAt = Date.now();
    const statsRequest = page.evaluate(async () => {
      const response = await globalThis.soulforge.runAiTool('workspace_stats', {});
      const data = response.ok ? response.data : null;
      return { statsOk: response.ok, paramRows: data?.paramRows ?? 0, textEntries: data?.textEntries ?? 0,
        rag: data?.semanticIndex?.rag, analysis: globalThis.__readinessProbe };
    });
    let sample;
    try { sample = await bounded(statsRequest, 10000, 'STATS_TIMEOUT'); }
    catch (error) {
      // Keep the same request alive to capture the final state/profile. Never
      // enqueue a second stats request behind a blocked main thread.
      report.errors.push({ code: 'STATS_TIMEOUT', elapsedMs: Date.now() - started });
      sample = await bounded(statsRequest, Math.max(1000, timeoutMs - (Date.now() - started)), 'STATS_DEADLINE_EXCEEDED');
    }
    sample.elapsedMs = Date.now() - started;
    sample.requestMs = Date.now() - sampledAt;
    report.samples.push(sample);
    if (sample.paramRows > 0 && !historyPromise) {
      report.firstParamMs = sample.elapsedMs;
      report.history = { status: 'pending', startedMs: sample.elapsedMs };
      const before = Date.now();
      historyPromise = page.evaluate(() => globalThis.soulforge.listOperations()).then(rows => {
        report.history = { status: 'completed', elapsedMs: Date.now() - before, count: rows.length };
      }, error => { report.history = { status: 'failed', elapsedMs: Date.now() - before, message: String(error) }; });
    }
    if (sample.textEntries > 0 && report.firstMsgMs === undefined) report.firstMsgMs = sample.elapsedMs;
    const families = sample.rag?.byFamily ?? {};
    const ready = sample.paramRows > 0 && sample.textEntries > 0
      && families.param_row > 0 && families.text_entry > 0;
    if (sample.elapsedMs - lastLog >= 10000 || ready) {
      console.log(JSON.stringify({ elapsedMs: sample.elapsedMs, param: sample.paramRows, msg: sample.textEntries,
        rag: families, history: report.history.status, analysis: sample.analysis.status }));
      lastLog = sample.elapsedMs;
    }
    if (ready && report.history.status === 'completed') { report.ok = report.errors.length === 0; report.readyMs = sample.elapsedMs; break; }
    if (sample.analysis.status === 'failed') break;
    await sleep(1000);
  }
  await page.screenshot({ path: join(output, 'end.png') }).catch(error => report.errors.push(String(error)));
  if (!report.ok) report.error = 'WORKSPACE_SEMANTIC_READINESS_NOT_REACHED';
} catch (error) { report.error = String(error); }
finally {
  report.elapsedMs = Date.now() - started;
  if (app) {
    try {
      const result = await bounded(app.evaluate(async () => {
        const profiler = globalThis.__readinessProfiler;
        if (!profiler) return null;
        const result = await profiler.post('Profiler.stop');
        profiler.session.disconnect();
        delete globalThis.__readinessProfiler;
        return result;
      }), 15000, 'PROFILER_STOP_TIMEOUT');
      if (result?.profile) {
        await writeFile(join(output, 'main.cpuprofile'), JSON.stringify(result.profile));
        report.cpuProfile = join(output, 'main.cpuprofile');
      }
    } catch (error) { report.profileError = String(error); }
    const child = app.process();
    await bounded(app.close().catch(() => undefined), 5000, 'CLOSE_TIMEOUT').catch(() => undefined);
    if (child.exitCode === null) child.kill();
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const target = resolve(scratch);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('soulforge-readiness-native-')) throw new Error('Unsafe scratch path');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(error => console.error(`Scratch cleanup: ${error.code}`));
  console.log(JSON.stringify({ ok: report.ok, firstParamMs: report.firstParamMs, firstMsgMs: report.firstMsgMs,
    readyMs: report.readyMs, history: report.history, reportPath: join(output, 'report.json'), error: report.error }));
  process.exitCode = report.ok ? 0 : 1;
}
