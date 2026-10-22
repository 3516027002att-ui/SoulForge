/** Actual Electron main V8, actual PARAM cache owners, deterministic native/commit seams. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopSmokeArgs, readDesktopSmokeLog, withDesktopTestBuild } from './desktop-test-build.mjs';
import { processSucceeded, runProcess } from './subprocess-control.mjs';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const electron = (await import('electron')).default;
const result = await withDesktopTestBuild('database', async ({ outputRoot, env, signal }) => {
  const entry = join(outputRoot, 'param-cache.cjs');
  await writeFile(entry, `const {app}=require('electron');
    (async()=>{await app.whenReady();
      await import(${JSON.stringify(pathToFileURL(resolve('scripts/param-memory-loader.mjs')).href)});
      process.argv=[process.argv[0],process.argv[1],${JSON.stringify(output)}];
      await import(${JSON.stringify(pathToFileURL(resolve('scripts/param-postcommit-cache-memory.experiment.mjs')).href)});
      app.quit();
    })().catch(error=>{console.error(error);app.exit(1);});`);
  const userData = join(outputRoot, '.runtime', 'electron-user-data');
  await mkdir(userData, { recursive: true });
  const logFile = join(outputRoot, '.runtime', 'electron.log');
  const args = [...desktopSmokeArgs(entry, true, logFile, userData), '--js-flags=--expose-gc'];
  const launched = await runProcess({ command: electron, args, cwd: process.cwd(), env: { ...env,
    SF_PARAM_CACHE_RUN_ROOT: join(outputRoot, 'fixtures'),
    ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: logFile }, signal, timeoutMs: 30000,
    onStdout: (chunk) => process.stdout.write(chunk) });
  const receipt = { command: electron, args,
    profile: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']
      .map((key) => [key, env[key]])),
    sourceRef: env.SF_PARAM_CACHE_SOURCE_REF ?? null, sandboxDisabled: false, result: launched,
    nativeLog: await readDesktopSmokeLog(logFile) };
  await writeFile(join(output, 'launch.json'), JSON.stringify(receipt, null, 2));
  if (!processSucceeded(launched)) console.error(JSON.stringify(receipt));
  return processSucceeded(launched);
}, { build: false });
if (!result) process.exitCode = 1;
