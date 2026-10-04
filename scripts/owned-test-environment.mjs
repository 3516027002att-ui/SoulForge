/** TEMP ownership for actual test operations, not a suite registry or result gate. */
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { attachOwnedTemporaryDirectory, createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';
import { createProcessCancellation, runProcess } from './subprocess-control.mjs';

export function resolveTestNpmCli(env = process.env) {
  const nodeDir = dirname(process.execPath);
  const candidates = [env.npm_execpath?.trim(), resolve(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
    resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  for (const directory of (env[pathKey] ?? '').split(delimiter)) {
    const shim = resolve(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (process.platform !== 'win32' && existsSync(shim)) {
      try { candidates.push(realpathSync(shim)); } catch { /* A broken PATH entry is not a usable npm. */ }
    }
  }
  const found = candidates.find(path => path && existsSync(path));
  if (!found) throw new Error('OWNED_TEST_NPM_UNAVAILABLE');
  return found;
}

function environmentValue(env, name) {
  const key = process.platform === 'win32'
    ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) : name;
  return env[key]?.trim();
}

const childSchema = 'soulforge.test-temporary-child.v1';
const closedName = '.soulforge-test-children-closed.json';

async function readReceipt(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readTestOwner(root, token) {
  const handle = await attachOwnedTemporaryDirectory(root);
  const record = JSON.parse(await readFile(join(root, '.soulforge-temporary-owner.json'), 'utf8'));
  if (record.owner !== 'test-operation' || !token || record.token !== token) throw new Error('OWNED_TEST_INHERITED_OWNER_INVALID');
  return { handle, record };
}

async function assertChildAdmissionOpen(parent) {
  await readTestOwner(parent.root, parent.token);
  try { await lstat(join(parent.root, closedName)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('OWNED_TEST_CHILD_ADMISSION_CLOSED');
}

async function registerChildIntent(parent) {
  await assertChildAdmissionOpen(parent);
  const { handle } = await readTestOwner(parent.root, parent.token);
  // A forced stop can occur before the parent reaches its cleanup catch. Keep
  // the relationship evidence until explicit, proof-checked tree disposal.
  await handle.retain('OWNED_TEST_CHILD_ADMISSION_PENDING');
  const id = randomUUID(), receipt = { schema: childSchema, id, parentToken: parent.token };
  const base = join(parent.root, `.soulforge-test-child.${id}`);
  // Record allocation before it happens. Interrupted/partial admission remains
  // an explicit cleanup failure, never an unrecorded "cleaned" sibling root.
  await writeFile(`${base}.pending.json`, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  await assertChildAdmissionOpen(parent);
  return { parent, base, receipt };
}

async function disposeTestTree(owner, record, seen = new Set()) {
  if (seen.has(owner.root)) throw new Error('OWNED_TEST_CHILD_CYCLE');
  seen.add(owner.root);
  try { await readTestOwner(owner.root, record.token); }
  catch (error) {
    if (error.code === 'ENOENT') {
      try { await lstat(owner.root); }
      catch (missing) { if (missing.code === 'ENOENT') { await owner.dispose(); return; } throw missing; }
      throw new Error(`OWNED_TEMP_OWNERSHIP_CHANGED: ${owner.root}`);
    }
    throw error;
  }
  try {
    const closed = { schema: childSchema, parentToken: record.token };
    try { await writeFile(join(owner.root, closedName), JSON.stringify(closed), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readReceipt(join(owner.root, closedName));
      if (existing.schema !== childSchema || existing.parentToken !== record.token) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
    }
    // This is a closed owner's explicit child ledger, not a sibling-directory
    // sweep. Every deletion still uses the original Job/process-group proof.
    for (const name of await readdir(owner.root)) {
      const match = /^\.soulforge-test-child\.([a-f0-9-]{36})\.pending\.json$/.exec(name);
      if (!match) continue;
      const pending = await readReceipt(join(owner.root, name));
      if (pending.schema !== childSchema || pending.id !== match[1] || pending.parentToken !== record.token) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
      let child;
      try { child = await readReceipt(join(owner.root, name.replace('.pending.json', '.json'))); }
      catch (error) { throw new Error(`OWNED_TEST_CHILD_ADMISSION_UNCERTAIN: ${owner.root}: ${error.message}`); }
      if (child.schema !== childSchema || child.id !== pending.id || child.parentToken !== record.token) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
      if (child.root === null && child.token === null) continue; // Allocation itself failed, before a writer existed.
      if (typeof child.root !== 'string' || child.root !== resolve(child.root) || child.root === owner.root
      || dirname(child.root) !== dirname(owner.root)
      || ![`sf-owned-${record.scope}-test-operation-`, `sft-${record.scope}-`].some(prefix => basename(child.root).startsWith(prefix))
        || typeof child.token !== 'string' || !child.token) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
      try {
        const ownedChild = await readTestOwner(child.root, child.token);
        if (ownedChild.record.scope !== record.scope || ownedChild.record.observer !== record.observer) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
        let parentReceipt;
        try { parentReceipt = await readReceipt(join(child.root, '.soulforge-test-parent.json')); }
        catch { throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID'); }
        if (parentReceipt.schema !== childSchema || parentReceipt.id !== child.id || parentReceipt.parentRoot !== owner.root
          || parentReceipt.parentToken !== record.token || parentReceipt.childToken !== child.token) throw new Error('OWNED_TEST_CHILD_RECEIPT_INVALID');
        await disposeTestTree(ownedChild.handle, ownedChild.record, seen);
      } catch (error) {
        // A normally completed nested wrapper may already have disposed itself.
        if (error.code === 'ENOENT') {
          try { await lstat(child.root); } catch (missing) { if (missing.code === 'ENOENT') continue; }
        }
        throw error;
      }
    }
    await owner.dispose();
  } catch (error) {
    // This node's identity was verified before visiting its children. Keep
    // failure evidence durable through normal exit and future owner admission.
    try { await owner.retain(error.message); }
    catch (retentionError) { throw new Error(`${error.message}; OWNED_TEST_RETENTION_FAILED: ${retentionError.message}`); }
    throw error;
  }
}

async function temporaryParent(env) {
  const names = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR', 'TMP', 'TEMP'];
  const requested = names.map(name => environmentValue(env, name)).find(Boolean) ?? tmpdir();
  const inheritedRoot = env.SOULFORGE_TEST_TEMP_OWNER_ROOT;
  // An explicitly changed TEMP is a new admission root, not a borrowed owner.
  // Otherwise nested wrappers allocate siblings, not ever-longer TEMP chains.
  if (inheritedRoot && resolve(requested) === join(resolve(inheritedRoot), 'tmp')) {
    const token = env.SOULFORGE_TEST_TEMP_OWNER_TOKEN;
    await readTestOwner(inheritedRoot, token);
    if (await realpath(requested) !== resolve(requested)) throw new Error('OWNED_TEST_INHERITED_OWNER_INVALID');
    const root = await realpath(inheritedRoot);
    return { parent: dirname(root), inherited: { root, token } };
  }
  return { parent: requested };
}

function temporaryEnvironment(env, temporaryRoot) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (['TEMP', 'TMP', 'TMPDIR'].includes(process.platform === 'win32' ? key.toUpperCase() : key)) delete result[key];
  }
  delete result.SOULFORGE_TEST_TEMP_OWNER_ROOT;
  delete result.SOULFORGE_TEST_TEMP_OWNER_TOKEN;
  return { ...result, TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot };
}

async function delegatedNpmEnvironment(args, cwd, env) {
  if (!['run', 'run-script'].includes(args[0]) || !args[1] || args[1].startsWith('-') || !env.npm_lifecycle_event) return env;
  const flags = args.slice(2, args.indexOf('--') < 0 ? undefined : args.indexOf('--'));
  if (flags.some(flag => !['--silent', '--if-present'].includes(flag))) return env;
  const manifest = resolve(cwd, 'package.json');
  if (env.npm_package_json !== manifest) return env;
  try {
    const info = await lstat(manifest);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(manifest) !== manifest
      || typeof JSON.parse(await readFile(manifest, 'utf8')).scripts?.[args[1]] !== 'string') return env;
  } catch { return env; }
  // npm's run-script set-path prepends this exact cwd-to-root sequence again.
  // Remove only those exact inherited spellings for a same-package lifecycle
  // delegation; keep unknown/alias entries and all other search order intact.
  const restored = new Set();
  for (let directory = resolve(cwd);;) {
    restored.add(join(directory, 'node_modules', '.bin'));
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  const result = { ...env };
  for (const key of Object.keys(result).filter(key => /^path$/i.test(key))) {
    if (typeof result[key] === 'string') result[key] = result[key].split(delimiter).filter(value => !restored.has(value)).join(delimiter);
  }
  return result;
}

const cancelledResult = () => ({ code: null, signal: null, stdout: '', stderr: '', stdoutTruncated: false,
  stderrTruncated: false, timedOut: false, cancelled: true, terminationReason: 'cancelled' });

/** Keep original cwd/argv/output; only descendants' temporary paths are redirected. */
export async function runOwnedTestOperation({ command, args = [], cwd = process.cwd(), env = process.env, timeoutMs, signal, onStdout, onStderr }) {
  if (signal?.aborted) return cancelledResult();
  let owner, record, relationship, result;
  try {
    const allocation = await temporaryParent(env);
    if (allocation.inherited) relationship = await registerChildIntent(allocation.inherited);
    owner = await createOwnedTemporaryDirectory('test-operation', { parent: allocation.parent, compact: true });
    record = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
    if (relationship) {
      await writeFile(join(owner.root, '.soulforge-test-parent.json'), JSON.stringify({ ...relationship.receipt,
        parentRoot: relationship.parent.root, childToken: record.token }), { flag: 'wx', mode: 0o600 });
      await writeFile(`${relationship.base}.json`, JSON.stringify({ ...relationship.receipt, root: owner.root, token: record.token }), { flag: 'wx', mode: 0o600 });
      await assertChildAdmissionOpen(relationship.parent);
    }
    const temporaryRoot = join(owner.root, 'tmp');
    await mkdir(temporaryRoot);
    if (signal?.aborted) result = cancelledResult();
    else {
      const isNpm = command === 'npm' || command === 'npm.cmd';
      const childEnv = isNpm ? await delegatedNpmEnvironment(args, cwd, env) : env;
      // Bare node follows this wrapper's runtime, as it does in runSuite.
      const executable = isNpm || command === 'node' ? process.execPath : command;
      const childArgs = isNpm ? [resolveTestNpmCli(childEnv), ...args] : args;
      result = await runProcess({ command: executable, args: childArgs, cwd,
        env: { ...temporaryEnvironment(childEnv, temporaryRoot), SOULFORGE_TEST_TEMP_OWNER_ROOT: owner.root,
          SOULFORGE_TEST_TEMP_OWNER_TOKEN: record.token }, owner, signal, timeoutMs,
        // This value survives JSON IPC (Infinity becomes null). Classification
        // requires complete output, including a skip before a very long tail.
        outputLimitBytes: Number.MAX_SAFE_INTEGER, onStdout, onStderr });
      if (result.stdoutTruncated || result.stderrTruncated) {
        result = { ...result, childExitCode: result.code, code: 1, outputError: 'OWNED_TEST_OUTPUT_TRUNCATED' };
      }
      if (result.terminationReason === 'supervisor-exit') {
        result = { ...result, childExitCode: result.code, code: result.code || 1, outputError: 'OWNED_TEST_RESULT_UNAVAILABLE' };
      }
    }
  } catch (error) {
    result = { code: null, stdout: '', stderr: error.message, spawnError: error.message,
      stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: signal?.aborted === true,
      terminationReason: 'ownership-or-spawn-error' };
  } finally {
    if (relationship && !owner) {
      try { await writeFile(`${relationship.base}.json`, JSON.stringify({ ...relationship.receipt, root: null, token: null }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { result = { ...result, code: 1, cleanupError: `OWNED_TEST_CHILD_ADMISSION_UNCERTAIN: ${error.message}` }; }
    }
    if (owner) {
      try {
        // dispose checks the persisted process group / Windows Job receipt.
        // A zero exit code alone never authorizes deleting a surviving tree.
        if (record) await disposeTestTree(owner, record);
        else await owner.dispose();
        result.temporaryOwnership = { root: owner.root, state: 'cleaned' };
      } catch (error) {
        result = { ...result, childExitCode: result.code, code: result.code || 1,
          temporaryOwnership: { root: owner.root, state: 'retained', error: error.message },
          cleanupError: error.message, stderr: `${result.stderr ?? ''}\nOWNED_TEST_CLEANUP_FAILED: ${error.message}\n` };
      }
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [separator, command, ...args] = process.argv.slice(2);
  if (separator !== '--' || !command) throw new Error('Usage: node scripts/owned-test-environment.mjs -- <command> [args...]');
  const cancellation = createProcessCancellation();
  let result;
  try { result = await runOwnedTestOperation({ command, args, cwd: process.cwd(), signal: cancellation.signal,
    onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) }); }
  finally { cancellation.dispose(); }
  if (result.spawnError || result.cleanupError || result.outputError) {
    process.stderr.write(`OWNED_TEST_EXECUTION_FAILED: ${result.spawnError ?? result.cleanupError ?? result.outputError}\n`);
  }
  process.exitCode = result.timedOut || result.cancelled ? 1 : result.code ?? 1;
}
