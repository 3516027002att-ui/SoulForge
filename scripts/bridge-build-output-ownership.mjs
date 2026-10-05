import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as temporary from './owned-temporary-directory.mjs';

const schema = 'soulforge.bridge-build-output-owner.v1';
const storeName = '.soulforge-build-output-ownership';
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const observer = () => temporary.ownedTemporaryDirectoryObserver?.() ?? null;

function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function stat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// Check every component, not just realpath's final destination. Linked bin trees
// and linked files never become owned, even when they point back inside bin.
async function plainPath(root, path, directory = false) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel.split(sep).includes('..')) return null;
  let current = root;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = await stat(current);
    if (!info || info.isSymbolicLink() || (current !== path && !info.isDirectory())) return null;
    if (current === path) return (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) ? info : null;
  }
  return null;
}

async function context(project, create = false) {
  project = resolve(project);
  const info = await stat(project);
  if (!info?.isFile() || info.isSymbolicLink()) return null;
  project = await realpath(project);
  const root = dirname(project), bin = join(root, 'bin'), obj = join(root, 'obj'), store = join(obj, storeName);
  if (create && !await stat(bin)) await mkdir(bin).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!await plainPath(root, bin, true)) return null;
  if (create && !await stat(obj)) await mkdir(obj).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!await plainPath(root, obj, true)) return null;
  if (create && !await stat(store)) await mkdir(store).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!await plainPath(obj, store, true)) return null;
  return { project, root, bin, obj, store, scope: createHash('sha256').update(project).digest('hex') };
}

async function readRecord(c, name, kind) {
  const path = join(c.store, name), info = await plainPath(c.store, path);
  if (!info || info.size > 4 * 1024 * 1024) return null;
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.schema !== schema || record.scope !== c.scope || record.kind !== kind
      || !tokenPattern.test(record.token) || name !== `${record.token}.${kind}.json`) return null;
    if (kind === 'lease' && (!Number.isSafeInteger(record.pid) || record.pid <= 0
      || !Number.isSafeInteger(record.preparingPid) || record.preparingPid <= 0
      || !['preparing', 'building'].includes(record.phase))) return null;
    if (kind === 'lease' && record.phase === 'building' && (!record.baseline || typeof record.baseline !== 'object'
      || Array.isArray(record.baseline) || Object.values(record.baseline).some(value => !Array.isArray(value)
        || value.length !== 4 || !value.every(Number.isFinite)))) return null;
    return record;
  } catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return null; throw error; }
}

async function records(c, kind) {
  const found = [];
  for (const name of await readdir(c.store)) {
    if (name.endsWith(`.${kind}.json`)) found.push({ name, record: await readRecord(c, name, kind) });
  }
  return found;
}

async function save(c, record) {
  const path = join(c.store, `${record.token}.${record.kind}.json`);
  if (record.run && record.run !== `obj/.soulforge-build-runs/${record.token}`) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  const pendingRoot = record.run ? join(c.root, ...record.run.split('/')) : c.store;
  const pending = join(pendingRoot, `.ownership-${record.kind}-${randomUUID()}.json`);
  if (!await plainPath(c.root, c.store, true)) return;
  await writeFile(pending, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  await rename(pending, path);
}

function outputFile(c, record, path, area = 'bin') {
  if (!['bin', 'obj'].includes(area)) return null;
  if (typeof record.output !== 'string' || typeof record.framework !== 'string' || typeof path !== 'string') return null;
  const parts = record.output.split('/');
  if (![2, 3].includes(parts.length) || parts[1] !== record.framework
    || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) return null;
  const components = path.split('/');
  if (!path.startsWith(`${record.output}/`) || components.includes('publish')
    || components.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
  const root = c[area], absolute = resolve(root, ...components);
  return relative(root, absolute).startsWith(`..${sep}`) ? null : absolute;
}

const fileKey = file => file.area === 'obj' ? `obj:${file.path}` : file.path;
const fileEntry = file => ({ path: file.path, hash: file.hash, ...(file.area === 'obj' ? { area: 'obj' } : {}) });

async function declaredFrameworks(c) {
  const xml = (await readFile(c.project, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const frameworks = [...xml.matchAll(/<TargetFrameworks?>\s*([^<]+)\s*<\/TargetFrameworks?>/g)]
    .flatMap(match => match[1].trim().split(';').map(value => value.trim()));
  return frameworks.length && frameworks.every(value => /^[A-Za-z0-9._-]+$/.test(value)) ? new Set(frameworks) : null;
}

function latestFiles(c, found) {
  const files = new Map();
  for (const { record } of found) {
    if (!record || !Number.isFinite(record.completedAt) || !Array.isArray(record.files)) continue;
    for (const file of record.files) {
      if (!outputFile(c, record, file.path, file.area) || !/^[a-f0-9]{64}$/.test(file.hash)) continue;
      const previous = files.get(fileKey(file));
      if (!previous || previous.record.completedAt < record.completedAt
        || (previous.record.completedAt === record.completedAt && previous.record.token < record.token)) files.set(fileKey(file), { record, file });
    }
  }
  return files;
}

async function hashFile(c, path, area = 'bin') {
  if (!await plainPath(c[area], path)) return null;
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function removeOwnedOutputs(c, found, eligible) {
  const directories = new Map();
  for (const { record, file } of latestFiles(c, found).values()) {
    const area = file.area ?? 'bin', path = outputFile(c, record, file.path, area);
    if (!path || !eligible(record) || await hashFile(c, path, area) !== file.hash) continue;
    await unlink(path);
    for (let parent = dirname(path); parent !== c[area]; parent = dirname(parent)) directories.set(parent, c[area]);
  }
  for (const path of [...directories.keys()].sort((a, b) => b.length - a.length)) {
    if (!await plainPath(directories.get(path), path, true)) continue;
    await rmdir(path).catch(error => { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; });
  }
  for (const { name, record } of found) {
    if (record && eligible(record)) await unlink(join(c.store, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

const fingerprint = info => [info.size, info.mtimeMs, info.ctimeMs, info.ino];
async function snapshot(c, output) {
  const result = {};
  async function visit(directory) {
    if (!await plainPath(c.bin, directory, true)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === 'publish') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else { const info = await plainPath(c.bin, path); if (info) result[relative(c.bin, path).split(sep).join('/')] = fingerprint(info); }
    }
  }
  await visit(output); return result;
}

async function leaseIsActive(c, record) {
  if (record.run !== undefined) {
    if (record.run !== `obj/.soulforge-build-runs/${record.token}`) return true;
    return !await temporary.ownedTemporaryDirectoryIsIdle(join(c.root, ...record.run.split('/')), 'bridge-build', record.token);
  }
  if (!observer() || record.observer !== observer()) return true;
  return live(record.pid) || (record.phase === 'preparing' && live(record.preparingPid));
}

/** Only the default build output is eligible. Explicit/custom outputs remain untouched. */
export async function beginBridgeBuild({ project, outputPath, framework, configuration, runtimeIdentifier = '', ownerPid = process.pid, token = randomUUID(), run }) {
  if (!tokenPattern.test(token) || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('BRIDGE_OUTPUT_OWNER_INVALID');
  const skipped = { token };
  if (!configuration || !framework) return skipped;
  if (![configuration, framework, runtimeIdentifier].every(value => typeof value === 'string'
    && (value === '' || (/^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..')))) return skipped;
  const projectRoot = dirname(resolve(project));
  const expected = join(projectRoot, 'bin', configuration, framework, runtimeIdentifier);
  if (resolve(projectRoot, outputPath) !== expected) return skipped;
  const c = await context(project, true); if (!c) return skipped;
  const declared = await declaredFrameworks(c);
  const output = relative(c.bin, expected).split(sep).join('/');
  const lease = { schema, kind: 'lease', scope: c.scope, observer: observer(), token, pid: ownerPid, preparingPid: process.pid, phase: 'preparing', framework, output,
    ...(run ? { run } : {}) };
  await save(c, lease);
  try {
    const otherLeases = await records(c, 'lease');
    let anotherActive = false;
    for (const { record } of otherLeases) if (!record || (record.token !== token && await leaseIsActive(c, record))) anotherActive = true;
    if (declared?.has(framework) && !anotherActive) {
      await removeOwnedOutputs(c, await records(c, 'outputs'), record => !declared.has(record.framework));
    }
    lease.baseline = await snapshot(c, expected);
  } catch (error) {
    lease.baseline = null; console.warn(`Bridge output ownership preserved uncertain outputs: ${error.message}`);
  } finally {
    lease.phase = 'building'; await save(c, lease);
  }
  // A newcomer waits for cleanup already in progress. Simultaneous prepares
  // publish 'building' before waiting, so they never wait on each other forever.
  while ((await records(c, 'lease')).some(({ record }) => record && record.token !== token && record.phase === 'preparing'
    && observer() && record.observer === observer() && live(record.preparingPid))) await delay(25);
  for (const { name, record } of await records(c, 'lease')) {
    if (record && !await leaseIsActive(c, record)) await unlink(join(c.store, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { token };
}

async function ensureDirectories(root, path) {
  const parts = relative(root, path).split(sep).filter(Boolean);
  if (parts.includes('..') || isAbsolute(relative(root, path))) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!await stat(current)) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!await plainPath(root, current, true)) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  }
}

async function identity(root, path) {
  if (!await plainPath(root, path)) return null;
  const info = await lstat(path, { bigint: true });
  return info.ino > 0n && info.dev > 0n ? { dev: String(info.dev), ino: String(info.ino) } : null;
}

async function recoverRenamedFiles(c, record) {
  if (!Array.isArray(record.renaming)) return;
  const recorded = new Set(record.files.map(fileKey));
  for (const proof of record.renaming) {
    if (!/^[0-9]{1,64}$/.test(proof.dev) || !/^[1-9][0-9]{0,63}$/.test(proof.ino) || !/^[a-f0-9]{64}$/.test(proof.hash)) continue;
    const area = proof.area ?? 'bin', path = outputFile(c, record, proof.path, area);
    if (!path) continue;
    const current = await identity(c[area], path);
    if (current?.dev === proof.dev && current.ino === proof.ino && await hashFile(c, path, area) === proof.hash && !recorded.has(fileKey(proof))) {
      record.files.push(fileEntry(proof)); recorded.add(fileKey(proof));
    }
  }
  delete record.renaming; delete record.planned; record.status = 'interrupted'; record.completedAt = Date.now();
  await save(c, record);
}

/** Allocate the evaluation-selected run before SDK/native output writers enter. */
export async function beginIsolatedBridgeBuild(input) {
  const { project, token, runRoot, outputPath, canonicalOutputPath, framework, configuration, runtimeIdentifier = '', ownerPid = process.pid } = input;
  if (!tokenPattern.test(token)) throw new Error('BRIDGE_OUTPUT_OWNER_INVALID');
  if (!configuration || !framework || ![configuration, framework, runtimeIdentifier].every(value => typeof value === 'string'
    && (value === '' || (/^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..')))) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  const c = await context(project, true); if (!c) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  const run = `obj/.soulforge-build-runs/${token}`, expectedRoot = join(c.root, ...run.split('/'));
  const canonical = join(c.bin, configuration, framework, runtimeIdentifier);
  if (resolve(runRoot) !== expectedRoot || resolve(canonicalOutputPath) !== canonical
    || resolve(outputPath) !== join(expectedRoot, 'bin', configuration, framework, runtimeIdentifier)) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  const runs = dirname(expectedRoot); await ensureDirectories(c.root, runs);
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !tokenPattern.test(entry.name)) continue;
    const old = join(runs, entry.name);
    if (!await temporary.ownedTemporaryDirectoryIsIdle(old, 'bridge-build', entry.name)) continue;
    const outputs = await readRecord(c, `${entry.name}.outputs.json`, 'outputs');
    if (outputs?.run === `obj/.soulforge-build-runs/${entry.name}`) await recoverRenamedFiles(c, outputs);
    const lease = await readRecord(c, `${entry.name}.lease.json`, 'lease');
    if (lease?.run === `obj/.soulforge-build-runs/${entry.name}`) await unlink(join(c.store, `${entry.name}.lease.json`));
    // Retire the proven-idle lease first: a kill after removal must not leave
    // an unknown lease pointing at a run that this helper already reclaimed.
    await rm(old, { recursive: true });
  }
  await mkdir(expectedRoot); // Existing or linked roots are never adopted.
  const owner = await temporary.initializeOwnedTemporaryDirectory('bridge-build', expectedRoot, { ownerPid, token });
  const group = temporary.observeOwnedProcessGroup?.(ownerPid);
  if (group) await owner.trackProcessGroup(group);
  await owner.trackProcess(process.pid);
  await beginBridgeBuild({ project, token, outputPath: canonical, framework, configuration, runtimeIdentifier, ownerPid, run });
  const lease = await readRecord(c, `${token}.lease.json`, 'lease');
  if (!lease || lease.run !== run) throw new Error('BRIDGE_OUTPUT_OWNER_INVALID');
}

async function managedCompilation({ project, token, runRoot, sharedCompilation }, finished) {
  const c = await context(project), lease = c && await readRecord(c, `${token}.lease.json`, 'lease');
  if (!lease || lease.run !== `obj/.soulforge-build-runs/${token}` || resolve(runRoot) !== join(c.root, ...lease.run.split('/'))) throw new Error('BRIDGE_OUTPUT_OWNER_INVALID');
  const owner = await temporary.attachOwnedTemporaryDirectory(runRoot);
  if (finished) temporary.recordOwnedProcess({ root: runRoot, token }, lease.pid, { finished: true });
  else {
    const group = temporary.observeOwnedProcessGroup?.(lease.pid);
    if (group && String(sharedCompilation).toLowerCase() === 'false') await owner.trackProcessGroup(group);
    else await owner.trackProcess(lease.pid, { uncertainTree: true });
  }
}

/** A planned candidate is not ownership. Only completed canonical renames are recorded. */
export async function promoteBridgeBuild({ project, token, runRoot, outputPath, canonicalOutputPath, fileWrites }) {
  const c = await context(project); if (!c) throw new Error('BRIDGE_OUTPUT_BOUNDARY_INVALID');
  const lease = await readRecord(c, `${token}.lease.json`, 'lease');
  if (!lease || lease.run !== `obj/.soulforge-build-runs/${token}` || resolve(runRoot) !== join(c.root, ...lease.run.split('/'))
    || resolve(outputPath) !== join(runRoot, 'bin', ...lease.output.split('/'))
    || resolve(canonicalOutputPath) !== join(c.bin, ...lease.output.split('/'))) throw new Error('BRIDGE_OUTPUT_OWNER_INVALID');
  const owner = await temporary.attachOwnedTemporaryDirectory(runRoot); await owner.trackProcess(process.pid);
  const previous = await records(c, 'outputs'), known = latestFiles(c, previous), candidates = [];
  for (const value of new Set(fileWrites)) {
    const source = resolve(c.root, value);
    for (const area of ['bin', 'obj']) {
      const base = area === 'bin' ? outputPath : join(runRoot, 'intermediate', ...lease.output.split('/'));
      const rel = relative(base, source);
      if (!rel || isAbsolute(rel) || rel.split(sep).includes('..') || !await plainPath(runRoot, source)) continue;
      const path = `${lease.output}/${rel.split(sep).join('/')}`, destination = outputFile(c, lease, path, area);
      if (destination) candidates.push({ source, destination, path, rel, area, hash: createHash('sha256').update(await readFile(source)).digest('hex') });
    }
  }
  const record = { schema, kind: 'outputs', scope: c.scope, token, run: lease.run, framework: lease.framework, output: lease.output,
    completedAt: Date.now(), status: 'promoting', planned: candidates.map(fileEntry), renaming: [], files: [] };
  await save(c, record);
  for (const candidate of candidates) {
    if (await hashFile(c, candidate.destination, candidate.area) === candidate.hash) continue;
    const destinationInfo = await stat(candidate.destination);
    if (destinationInfo && (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || destinationInfo.nlink !== 1)) throw new Error('BRIDGE_OUTPUT_DESTINATION_UNCERTAIN');
    await ensureDirectories(c[candidate.area], dirname(candidate.destination));
    const pending = join(runRoot, 'promotion', candidate.area, ...candidate.rel.split(sep));
    await ensureDirectories(runRoot, dirname(pending));
    await copyFile(candidate.source, pending, constants.COPYFILE_EXCL);
    const proof = await identity(runRoot, pending);
    if (proof) { record.renaming.push({ ...fileEntry(candidate), ...proof }); await save(c, record); }
    await rename(pending, candidate.destination);
    if (await hashFile(c, candidate.destination, candidate.area) !== candidate.hash) throw new Error('BRIDGE_OUTPUT_PROMOTION_CHANGED');
    record.files.push(fileEntry(candidate));
    record.renaming = record.renaming.filter(value => fileKey(value) !== fileKey(candidate));
    record.completedAt = Date.now(); await save(c, record);
  }
  const recorded = new Set(record.files.map(fileKey));
  for (const { record: old, file } of known.values()) {
    if (old.output !== lease.output || recorded.has(fileKey(file))) continue;
    const path = outputFile(c, lease, file.path, file.area);
    if (path && await hashFile(c, path, file.area) === file.hash) record.files.push(fileEntry(file));
  }
  record.status = 'complete'; delete record.planned; delete record.renaming; record.completedAt = Date.now(); await save(c, record);
  let anotherActive = false;
  for (const { record: other } of await records(c, 'lease')) if (!other || (other.token !== token && await leaseIsActive(c, other))) anotherActive = true;
  if (!anotherActive) for (const { name, record: old } of previous) {
    if (old?.output === record.output && old.completedAt <= record.completedAt) await unlink(join(c.store, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function cleanCanonicalBridgeBuild({ project, token }) {
  const c = await context(project), lease = c && await readRecord(c, `${token}.lease.json`, 'lease');
  if (!lease || lease.run !== `obj/.soulforge-build-runs/${token}`) return;
  const owner = await temporary.attachOwnedTemporaryDirectory(join(c.root, ...lease.run.split('/')));
  await owner.trackProcess(process.pid);
  for (const { record } of await records(c, 'lease')) {
    if (!record || (record.token !== token && await leaseIsActive(c, record))) return;
  }
  await removeOwnedOutputs(c, await records(c, 'outputs'), record => record.output === lease.output && record.framework === lease.framework);
}

/** Record actual successful FileWrites, never a directory listing or old FileListAbsolute. */
export async function completeBridgeBuild({ project, token, fileWrites }) {
  if (!tokenPattern.test(token)) throw new Error('BRIDGE_OUTPUT_OWNER_INVALID');
  const c = await context(project); if (!c) return;
  const lease = await readRecord(c, `${token}.lease.json`, 'lease'); if (!lease) return;
  if (!lease.baseline || typeof lease.baseline !== 'object') return;
  const previous = await records(c, 'outputs'), known = latestFiles(c, previous), files = [];
  for (const value of new Set(fileWrites)) {
    const absolute = resolve(c.root, value), path = relative(c.bin, absolute).split(sep).join('/');
    if (!outputFile(c, lease, path)) continue;
    const info = await plainPath(c.bin, absolute); if (!info) continue;
    const hash = await hashFile(c, absolute); if (!hash) continue;
    // Incremental targets infer FileWrites even without copying: unchanged,
    // unowned pre-existing binaries must not acquire a new ownership marker.
    if (JSON.stringify(lease.baseline[path]) === JSON.stringify(fingerprint(info)) && known.get(path)?.file.hash !== hash) continue;
    files.push({ path, hash });
  }
  // Renames and incremental builds can omit still-present owned files.
  const recorded = new Set(files.map(fileKey));
  for (const { record: old, file } of known.values()) {
    if (old.output !== lease.output || recorded.has(fileKey(file))) continue;
    const path = outputFile(c, lease, file.path, file.area);
    if (path && await hashFile(c, path, file.area) === file.hash) files.push(fileEntry(file));
  }
  const record = { schema, kind: 'outputs', scope: c.scope, token, framework: lease.framework,
    output: lease.output, completedAt: Date.now(), files };
  await save(c, record); await unlink(join(c.store, `${token}.lease.json`));
  let anotherActive = false;
  for (const { record: other } of await records(c, 'lease')) if (!other || await leaseIsActive(c, other)) anotherActive = true;
  if (!anotherActive) {
    for (const { name, record: old } of previous) {
      if (old?.output === record.output && old.completedAt <= record.completedAt) await unlink(join(c.store, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(3), values = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2].replace(/^--/, ''), args[i * 2 + 1]]));
  const action = process.argv[2];
  try {
    if (action === 'begin-isolated') await beginIsolatedBridgeBuild({ project: values.project, token: values.token,
      runRoot: values['run-root'], outputPath: values.output, canonicalOutputPath: values.canonical,
      framework: values.framework, configuration: values.configuration, runtimeIdentifier: values.runtime, ownerPid: Number(values.owner) });
    else if (action === 'promote') await promoteBridgeBuild({ project: values.project, token: values.token,
      runRoot: values['run-root'], outputPath: values.output, canonicalOutputPath: values.canonical,
      fileWrites: (await readFile(values['file-list'], 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean) });
    else if (action === 'managed-start' || action === 'managed-finish') await managedCompilation({ project: values.project,
      token: values.token, runRoot: values['run-root'], sharedCompilation: values.shared }, action === 'managed-finish');
    else if (action === 'clean') await cleanCanonicalBridgeBuild({ project: values.project, token: values.token });
    else if (action === 'begin') await beginBridgeBuild({ project: values.project, outputPath: values.output,
      framework: values.framework, configuration: values.configuration, runtimeIdentifier: values.runtime,
      ownerPid: Number(values.owner), token: values.token });
    else if (action === 'complete') await completeBridgeBuild({ project: values.project, token: values.token,
      fileWrites: (await readFile(values['file-list'], 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean) });
    else throw new Error('BRIDGE_OUTPUT_OWNER_COMMAND_INVALID');
  } catch (error) {
    console.warn(`Bridge output ownership preserved uncertain outputs: ${error.message}`);
    if (['begin-isolated', 'promote', 'managed-start', 'managed-finish'].includes(action)) process.exitCode = 1;
  }
}
