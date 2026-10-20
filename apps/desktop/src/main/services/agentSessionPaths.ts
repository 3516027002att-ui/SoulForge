/**
 * Rollout session path resolution for ai.agent.sessions load/resume.
 *
 * A lexical prefix check is not enough: a junction or symbolic link under
 * sessions/ can redirect a read outside the session directory. Every
 * directory level and the final file are resolved with realpath and must stay
 * inside the physical sessions root. Callers read the returned physical path,
 * so retargeting the original alias after resolution cannot redirect the read.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isPathInside } from '@soulforge/core';

export type AgentSessionPathResolution =
  | { ok: true; absolute: string }
  | { ok: false; error: { code: string; message: string } };

const forbidden = (): AgentSessionPathResolution =>
  ({ ok: false, error: { code: 'ROLLOUT_PATH_FORBIDDEN', message: '会话路径必须位于会话目录内。' } });
const notFound = (): AgentSessionPathResolution =>
  ({ ok: false, error: { code: 'ROLLOUT_NOT_FOUND', message: '会话记录不存在。' } });

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

/** Physical sessions root; sessions/ itself must not alias a directory outside the base. */
function physicalSessionsRoot(base: string): string | AgentSessionPathResolution {
  let physicalBase: string;
  let physicalRoot: string;
  try {
    physicalBase = realpathSync(base);
    physicalRoot = realpathSync(join(base, 'sessions'));
  } catch {
    return notFound();
  }
  return isPathInside(physicalBase, physicalRoot) ? physicalRoot : forbidden();
}

function checkPhysical(physicalRoot: string, candidate: string, kind: 'directory' | 'file'): AgentSessionPathResolution {
  let physicalPath: string;
  try {
    physicalPath = realpathSync(candidate);
  } catch (error) {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR'
      ? notFound()
      : { ok: false, error: { code: 'ROLLOUT_READ_FAILED', message: '无法解析会话路径。' } };
  }
  if (!isPathInside(physicalRoot, physicalPath)) return forbidden();
  try {
    const info = statSync(physicalPath);
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) return notFound();
  } catch {
    return notFound();
  }
  return { ok: true, absolute: physicalPath };
}

/** Bounded YYYY/MM/DD walk; every level is checked before it is listed. */
function findRolloutInSessions(physicalRoot: string, sessionsRoot: string, targetFileName: string): AgentSessionPathResolution | null {
  const state: { blocked: AgentSessionPathResolution | null } = { blocked: null };
  const visit = (directory: string, remainingLevels: number): AgentSessionPathResolution | null => {
    const checked = checkPhysical(physicalRoot, directory, 'directory');
    if (!checked.ok) {
      if (checked.error.code === 'ROLLOUT_PATH_FORBIDDEN') state.blocked = checked;
      return null;
    }
    if (remainingLevels === 0) {
      const found = checkPhysical(physicalRoot, join(checked.absolute, targetFileName), 'file');
      if (!found.ok && found.error.code === 'ROLLOUT_PATH_FORBIDDEN') state.blocked = found;
      return found.ok ? found : null;
    }
    let entries: string[];
    try {
      entries = readdirSync(checked.absolute);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const found = visit(join(directory, entry), remainingLevels - 1);
      if (found) return found;
    }
    return null;
  };
  return visit(sessionsRoot, 3) ?? state.blocked;
}

/**
 * Resolve a session-relative rollout path (as returned by ai.agent.sessions),
 * or a bare rollout file name, to a checked physical file path.
 */
export function resolveAgentSessionPath(baseDir: string, sessionPath: string): AgentSessionPathResolution {
  const base = resolve(baseDir);
  const sessionsRoot = join(base, 'sessions');
  const normalized = sessionPath.replace(/^[\\/]+/, '');
  const absolute = resolve(base, normalized);
  if (!isPathInside(base, absolute)) return forbidden();

  const physicalRoot = physicalSessionsRoot(base);
  if (typeof physicalRoot !== 'string') return physicalRoot;

  const direct = checkPhysical(physicalRoot, absolute, 'file');
  if (direct.ok || direct.error.code !== 'ROLLOUT_NOT_FOUND') return direct;

  // 兼容直接传入纯文件名（如 rollout-2026-09-06T...jsonl）：优先按时间戳解析 sessions/YYYY/MM/DD/ 子目录
  const fileName = basename(normalized);
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T/i.exec(fileName);
  if (match) {
    const dated = checkPhysical(physicalRoot, join(sessionsRoot, match[1]!, match[2]!, match[3]!, fileName), 'file');
    if (dated.ok || dated.error.code !== 'ROLLOUT_NOT_FOUND') return dated;
  }
  const flat = checkPhysical(physicalRoot, join(sessionsRoot, fileName), 'file');
  if (flat.ok || flat.error.code !== 'ROLLOUT_NOT_FOUND') return flat;

  return findRolloutInSessions(physicalRoot, sessionsRoot, fileName) ?? notFound();
}
