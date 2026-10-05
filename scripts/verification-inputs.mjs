import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const kinds = new Set(['private-game-input','independent-oracle','published-control']);
const statuses = new Set(['missing','not-configured']);
const isItem = item => item && kinds.has(item.kind) && statuses.has(item.status)
  && (typeof item.sourceEnv === 'string' && item.sourceEnv.length > 0
    || typeof item.logicalResource === 'string' && item.logicalResource.length > 0);

export function missingConfiguration(value, item) {
  return typeof value === 'string' && value.trim() ? null : {...item,status:'not-configured'};
}

function missingPath(path, item, directory, expectedSha256) {
  if (!path?.trim()) return {...item,status:'not-configured'};
  let info;
  try { info = statSync(path); } catch (error) {
    if (error.code === 'ENOENT') return {...item,status:'missing'};
    throw error;
  }
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('VERIFICATION_INPUT_KIND_INVALID');
  if (expectedSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('VERIFICATION_INPUT_SHA_INVALID');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expectedSha256) throw new Error('VERIFICATION_INPUT_SHA_MISMATCH');
  }
  return null;
}

export const missingFile = (path,item,expectedSha256) => missingPath(path,item,false,expectedSha256);
export const missingDirectory = (path,item) => missingPath(path,item,true);

export function missingPrivateGameRoot() {
  const root = process.env.SF_REAL_GAME_ROOT?.trim() || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    || 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
  return missingDirectory(root,{kind:'private-game-input',logicalResource:'Sekiro game source root'});
}

// Read configured oracle JSON before deciding applicability. Malformed JSON,
// invalid source metadata and changed available native bytes are real failures.
export function oracleSourcePrerequisites(path, sourceEnv, selectSource, validateOracle) {
  const oracleMissing = missingFile(path,{kind:'independent-oracle',sourceEnv});
  if (oracleMissing) return [oracleMissing,missingPrivateGameRoot()].filter(Boolean);
  const oracle = JSON.parse(readFileSync(path,'utf8'));
  validateOracle(oracle);
  const source = selectSource(oracle);
  if (typeof source?.path !== 'string' || !source.path.trim() || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('VERIFICATION_ORACLE_SOURCE_INVALID');
  return [missingFile(source.path,{kind:'private-game-input',logicalResource:'oracle native source'},source.sha256)].filter(Boolean);
}

export function verificationSkipReason(prerequisites) {
  const missingPrerequisites = prerequisites.filter(Boolean);
  if (!missingPrerequisites.length) return undefined;
  if (!missingPrerequisites.every(isItem)) throw new Error('VERIFICATION_PREREQUISITES_INVALID');
  const code = missingPrerequisites.some(item=>item.kind==='private-game-input'&&item.status==='missing')
    ? 'PRIVATE_CORPUS_MISSING' : 'VERIFICATION_INPUT_MISSING';
  return JSON.stringify({code,missingPrerequisites});
}

export function parseVerificationSkipReason(text) {
  if (typeof text !== 'string' || text.length > 16384) return null;
  let reason;
  try { reason = JSON.parse(text); } catch { return null; }
  if (!['PRIVATE_CORPUS_MISSING','VERIFICATION_INPUT_MISSING'].includes(reason?.code)
    || !Array.isArray(reason.missingPrerequisites) || !reason.missingPrerequisites.length
    || reason.missingPrerequisites.length > 64 || !reason.missingPrerequisites.every(isItem)) return null;
  const expected = reason.missingPrerequisites.some(item=>item.kind==='private-game-input'&&item.status==='missing')
    ? 'PRIVATE_CORPUS_MISSING' : 'VERIFICATION_INPUT_MISSING';
  return reason.code === expected ? {code:reason.code,missingPrerequisites:reason.missingPrerequisites} : null;
}
