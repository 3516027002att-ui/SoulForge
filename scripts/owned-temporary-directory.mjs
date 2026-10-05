import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const scope = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 16);
const markerName = '.soulforge-temporary-owner.json';
const schema = 'soulforge.temporary-owner.v1';
const removalOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
const activeRoots = new Map();
// Linux observations are bound to boot/PID namespace. Windows is host-scoped;
// descendant uncertainty stays pinned when no process-tree proof is available.
const observer = (() => {
  try {
    const identity = process.platform === 'linux'
      ? `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${readlinkSync('/proc/self/ns/pid')}`
      : process.platform === 'win32' ? `win32:${hostname()}` : null;
    return identity && createHash('sha256').update(identity).digest('hex');
  } catch { return null; }
})();

export const ownedTemporaryDirectoryObserver = () => observer;

/** Observation is only useful in this boot/PID namespace; unknown stays null. */
export function observeOwnedProcessGroup(pid) {
  if (process.platform !== 'linux' || !observer || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const info = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = info.slice(info.lastIndexOf(')') + 2).split(' ');
    const group = Number(fields[2]);
    return fields[0] !== 'Z' && Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch { return null; }
}

// Covers ordinary early setup failures in existing standalone smokes. Forced
// termination is handled by marked dead-predecessor reclamation on restart.
process.once('exit', () => {
  for (const [root, record] of activeRoots) {
    try {
      const metadata = lstatSync(root);
      const marker = lstatSync(join(root, markerName));
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(root) !== root || !marker.isFile() || marker.isSymbolicLink()) {
        throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
      }
      const current = JSON.parse(readFileSync(join(root, markerName), 'utf8'));
      if (current.token !== record.token || current.directory !== basename(root)) throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
      if (current.uncertainTrees?.some(pid => !windowsJobProvesStopped(current, pid, root))) throw new Error('OWNED_TEMP_PROCESS_UNCERTAIN');
      if (childrenAreLive(current, root)) throw new Error('OWNED_TEMP_PROCESS_LIVE');
      rmSync(root, removalOptions);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      console.error(`OWNED_TEMP_CLEANUP_FAILED: ${root}: ${error.message}`);
      if (!process.exitCode) process.exitCode = 1;
    }
  }
});

function processIsLive(pid) {
  if (process.platform === 'linux') {
    try {
      const info = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (info.slice(info.lastIndexOf(')') + 2).split(' ')[0] === 'Z') return false;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return true; }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function groupIsLive(group) {
  try { process.kill(-group, 0); } catch (error) { return error.code !== 'ESRCH'; }
  if (process.platform !== 'linux') return true;
  try {
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let info;
      try { info = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return true; }
      const fields = info.slice(info.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === group && fields[0] !== 'Z') return true;
    }
    return false;
  } catch { return true; }
}

function childrenAreLive(record, root) {
  return record.childPids.some(processIsLive) || (record.processGroups ?? []).some(groupIsLive)
    || (record.uncertainTrees ?? []).some(pid => !windowsJobProvesStopped(record, pid, root));
}

function windowsJobProvesStopped(record, pid, root) {
  if (process.platform !== 'win32') return false;
  const job = (record.windowsJobs ?? []).find(value => value.pid === pid);
  if (!job) return false;
  if (!root) return false;
  try {
    const path = join(root, `.soulforge-windows-job.${job.id}.json`), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) return false;
    const proof = JSON.parse(readFileSync(path, 'utf8'));
    if (proof.schema !== 'soulforge.windows-job.v1' || proof.id !== job.id || proof.token !== record.token
      || proof.observer !== record.observer || proof.supervisorPid !== pid || proof.killOnClose !== true
      || !['assigned', 'finished'].includes(proof.state)
      || ![proof.guardianPid, proof.driverPid].every(value => Number.isSafeInteger(value) && value > 0)) return false;
    // Assigned before resume, with the guardian as the only non-inheritable
    // KILL_ON_JOB_CLOSE holder. Guardian death closes that job and kills its tree.
    return !processIsLive(proof.guardianPid) && !processIsLive(proof.driverPid);
  } catch { return false; }
}

function validProcesses(record) {
  return ['childPids', 'processGroups', 'uncertainTrees'].every(key =>
    (key !== 'childPids' && record[key] === undefined) || (Array.isArray(record[key])
      && record[key].every(pid => Number.isSafeInteger(pid) && pid > 0)))
    && (record.windowsJobs === undefined || (Array.isArray(record.windowsJobs)
      && record.windowsJobs.every(job => job && typeof job === 'object' && /^[a-f0-9-]{36}$/.test(job.id)
        && Number.isSafeInteger(job.pid) && job.pid > 0)));
}

/** The already-recorded supervisor adds its real writer PID and completion. */
export function recordOwnedProcess(ticket, pid, { finished = false } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('OWNED_TEMP_CHILD_PID_INVALID');
  const root = resolve(ticket.root), path = join(root, markerName);
  const directory = lstatSync(root), marker = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(root) !== root || !marker.isFile() || marker.isSymbolicLink()) throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.schema !== schema || record.scope !== scope || record.token !== ticket.token
    || record.directory !== basename(root) || record.observer !== observer || !validProcesses(record)) throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
  if (!record.childPids.includes(pid)) record.childPids.push(pid);
  if (finished) record.uncertainTrees = (record.uncertainTrees ?? []).filter(value => value !== pid);
  const pending = `${path}.${randomUUID()}.next`;
  writeFileSync(pending, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); renameSync(pending, path);
}

/** Register the bounded job proof location while its supervisor is still gated. */
export function prepareOwnedWindowsJob(ticket, pid, id) {
  if (process.platform !== 'win32' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('OWNED_WINDOWS_JOB_INVALID');
  recordOwnedProcess(ticket, pid);
  const path = join(ticket.root, markerName), record = JSON.parse(readFileSync(path, 'utf8'));
  record.windowsJobs ??= [];
  record.windowsJobs.push({ pid, id });
  const pending = `${path}.${randomUUID()}.next`;
  writeFileSync(pending, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); renameSync(pending, path);
}

async function readOwner(root, owner) {
  try {
    const directory = await lstat(root);
    const marker = await lstat(join(root, markerName));
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== resolve(root)
      || !marker.isFile() || marker.isSymbolicLink() || marker.size > 8192) return null;
    const value = JSON.parse(await readFile(join(root, markerName), 'utf8'));
    if (value.schema !== schema || value.scope !== scope || value.owner !== owner
      || value.directory !== basename(root) || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.token !== 'string' || !validProcesses(value)) return null;
    return value;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Reclaim only this checkout/owner's marked dead predecessors, never sf-* by convention. */
export async function createOwnedTemporaryDirectory(owner, { parent = tmpdir() } = {}) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(owner)) throw new Error('OWNED_TEMP_OWNER_INVALID');
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new Error('OWNED_TEMP_PARENT_INVALID');
  parent = await realpath(parent);
  const prefix = `sf-owned-${scope}-${owner}-`;
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(parent, entry.name);
    const previous = await readOwner(candidate, owner);
    if (!previous || !observer || previous.observer !== observer || processIsLive(previous.pid) || childrenAreLive(previous, candidate)) continue;
    await rm(candidate, removalOptions);
  }
  const root = await mkdtemp(join(parent, prefix));
  try { return await initializeOwnedTemporaryDirectory(owner, root); }
  catch (error) { await rm(root, removalOptions); throw error; }
}

/** Initialize only an explicitly allocated writer root; this does not scan siblings. */
export async function initializeOwnedTemporaryDirectory(owner, root, { ownerPid = process.pid, token = randomUUID() } = {}) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(owner) || !Number.isSafeInteger(ownerPid) || ownerPid <= 0
    || typeof token !== 'string' || !token) throw new Error('OWNED_TEMP_OWNER_INVALID');
  // resolve() erases link/.. before the ancestor walk; realpath() can select a
  // different physical directory through that link. Writer roots never need ..
  if (typeof root !== 'string' || root.split(process.platform === 'win32' ? /[\\/]/ : '/').includes('..')) {
    throw new Error('OWNED_TEMP_PARENT_INVALID');
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('OWNED_TEMP_PARENT_INVALID');
  for (let current = resolve(root);;) {
    const component = await lstat(current);
    if (!component.isDirectory() || component.isSymbolicLink()) throw new Error('OWNED_TEMP_PARENT_INVALID');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Resolve the selected real directory before comparing/writing its ownership.
  // Windows TEMP can use a DOS short name for the same physical directory.
  root = await realpath(root);
  if ((await readdir(root)).length) throw new Error('OWNED_TEMP_ROOT_NOT_FRESH');
  root = resolve(root);
  const record = { schema, scope, owner, directory: basename(root), pid: ownerPid,
    childPids: [], processGroups: [], uncertainTrees: [], observer, token };
  await writeFile(join(root, markerName), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  if (ownerPid === process.pid) activeRoots.set(root, record);
  return directoryHandle(root, owner, record);
}

export async function attachOwnedTemporaryDirectory(root) {
  root = resolve(root);
  const info = await lstat(join(root, markerName));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
  const value = JSON.parse(await readFile(join(root, markerName), 'utf8'));
  const record = await readOwner(root, value.owner);
  if (!record || record.observer !== observer || !observer) throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
  return directoryHandle(root, value.owner, record);
}

/** Unknown ownership/observer/process state is deliberately not reclamation evidence. */
export async function ownedTemporaryDirectoryIsIdle(root, owner, token) {
  const record = await readOwner(resolve(root), owner);
  return Boolean(record && (!token || record.token === token) && observer && record.observer === observer
    && !processIsLive(record.pid) && !childrenAreLive(record, resolve(root)));
}

function directoryHandle(root, owner, record) {
  async function updateProcesses(update) {
    const current = await readOwner(root, owner);
    if (!current || current.token !== record.token) throw new Error('OWNED_TEMP_OWNERSHIP_CHANGED');
    Object.assign(record, current);
    record.processGroups ??= []; record.uncertainTrees ??= [];
    update(record);
    const pending = join(root, `${markerName}.${randomUUID()}.next`);
    await writeFile(pending, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(pending, join(root, markerName));
    return { root, token: record.token };
  }
  return {
    root,
    async trackProcess(pid, { processGroup = false, uncertainTree = false } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('OWNED_TEMP_CHILD_PID_INVALID');
      return updateProcesses(value => {
        if (!value.childPids.includes(pid)) value.childPids.push(pid);
        if (processGroup && !value.processGroups.includes(pid)) value.processGroups.push(pid);
        if (uncertainTree && !value.uncertainTrees.includes(pid)) value.uncertainTrees.push(pid);
      });
    },
    async trackProcessGroup(group) {
      if (!Number.isSafeInteger(group) || group <= 0) throw new Error('OWNED_TEMP_PROCESS_GROUP_INVALID');
      return updateProcesses(value => { if (!value.processGroups.includes(group)) value.processGroups.push(group); });
    },
    async dispose() {
      const current = await readOwner(root, owner);
      if (!current) {
        try { await lstat(root); } catch (error) { if (error.code === 'ENOENT') { activeRoots.delete(root); return; } throw error; }
        throw new Error(`OWNED_TEMP_OWNERSHIP_CHANGED: ${root}`);
      }
      if (current.token !== record.token) throw new Error(`OWNED_TEMP_OWNERSHIP_CHANGED: ${root}`);
      if (current.uncertainTrees?.some(pid => !windowsJobProvesStopped(current, pid, root))) throw new Error(`OWNED_TEMP_PROCESS_UNCERTAIN: ${root}`);
      if ((current.pid !== process.pid && processIsLive(current.pid)) || childrenAreLive(current, root)) throw new Error(`OWNED_TEMP_PROCESS_LIVE: ${root}`);
      await rm(root, removalOptions);
      activeRoots.delete(root);
    }
  };
}
