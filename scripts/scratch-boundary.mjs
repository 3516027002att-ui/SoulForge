import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path';

export class ScratchBoundaryError extends Error {
  constructor(code, message, reason) {
    super(message);
    this.name = 'ScratchBoundaryError';
    this.code = code;
    this.reason = reason;
  }
}

export async function resolveSafeScratchRoot({
  scratch,
  repositoryRoot,
  protectedRoots = []
}) {
  const configured = typeof scratch === 'string' ? scratch.trim() : '';
  if (!configured) {
    throw boundaryError(
      'SCRATCH_PATH_REQUIRED',
      'SOULFORGE_SCRATCH must be a non-empty absolute directory.',
      'missing'
    );
  }
  if (!isAbsolute(configured)) {
    throw boundaryError(
      'SCRATCH_PATH_NOT_ABSOLUTE',
      'SOULFORGE_SCRATCH must be an absolute directory.',
      'relative'
    );
  }

  const lexicalScratch = resolve(configured);
  if (isFileSystemRoot(lexicalScratch)) {
    throw boundaryError(
      'SCRATCH_FILESYSTEM_ROOT_FORBIDDEN',
      'SOULFORGE_SCRATCH must not be a filesystem root.',
      'filesystem-root'
    );
  }

  const boundaries = [
    { label: 'repository-workspace-root', path: repositoryRoot },
    ...protectedRoots
  ].filter((item) => typeof item?.path === 'string' && item.path.trim().length > 0);

  for (const boundary of boundaries) {
    const lexicalBoundary = resolve(boundary.path);
    rejectOverlap(lexicalScratch, lexicalBoundary, boundary.label, 'lexical');
  }

  const physicalScratch = await projectThroughNearestPhysicalAncestor(
    lexicalScratch,
    true,
    'scratch-root'
  );
  if (isFileSystemRoot(physicalScratch)) {
    throw boundaryError(
      'SCRATCH_FILESYSTEM_ROOT_FORBIDDEN',
      'SOULFORGE_SCRATCH must not resolve to a filesystem root.',
      'physical-filesystem-root'
    );
  }

  for (const boundary of boundaries) {
    const physicalBoundary = await projectThroughNearestPhysicalAncestor(
      resolve(boundary.path),
      false,
      boundary.label
    );
    rejectOverlap(physicalScratch, physicalBoundary, boundary.label, 'physical');
  }

  return lexicalScratch;
}

export function scratchBoundaryFailure(error) {
  if (error instanceof ScratchBoundaryError) {
    return {
      code: error.code,
      reason: error.reason,
      message: error.message
    };
  }
  return {
    code: 'SCRATCH_BOUNDARY_RESOLUTION_FAILED',
    reason: 'unexpected',
    message: 'SOULFORGE_SCRATCH could not be validated safely.'
  };
}

async function projectThroughNearestPhysicalAncestor(path, requireDirectory, label) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw boundaryError(
          'SCRATCH_PATH_RESOLUTION_FAILED',
          `Unable to resolve the existing ancestor for ${label}.`,
          'ancestor-resolution-failed'
        );
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw boundaryError(
          'SCRATCH_PATH_RESOLUTION_FAILED',
          `Unable to locate an existing ancestor for ${label}.`,
          'ancestor-missing'
        );
      }
      suffix.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    let physicalAncestor;
    try {
      physicalAncestor = await realpath(cursor);
    } catch {
      throw boundaryError(
        'SCRATCH_PATH_RESOLUTION_FAILED',
        `Unable to resolve the physical path for ${label}.`,
        'physical-resolution-failed'
      );
    }
    let physicalInfo;
    try {
      physicalInfo = await lstat(physicalAncestor);
    } catch {
      throw boundaryError(
        'SCRATCH_PATH_RESOLUTION_FAILED',
        `Unable to inspect the physical path for ${label}.`,
        'physical-inspection-failed'
      );
    }
    if ((suffix.length > 0 || requireDirectory) && !physicalInfo.isDirectory()) {
      throw boundaryError(
        'SCRATCH_PATH_NOT_DIRECTORY',
        `The configured ${label} path is not backed by a directory ancestor.`,
        'non-directory-ancestor'
      );
    }
    return resolve(physicalAncestor, ...suffix);
  }
}

function rejectOverlap(scratch, boundary, label, resolutionKind) {
  if (!pathsOverlap(scratch, boundary)) return;
  throw boundaryError(
    'SCRATCH_PROTECTED_ROOT_OVERLAP',
    `SOULFORGE_SCRATCH must not contain or be contained by ${label}.`,
    `${resolutionKind}-overlap:${label}`
  );
}

function pathsOverlap(left, right) {
  const normalizedLeft = comparablePath(left);
  const normalizedRight = comparablePath(right);
  if (normalizedLeft === normalizedRight) return true;
  return normalizedLeft.startsWith(withTrailingSeparator(normalizedRight))
    || normalizedRight.startsWith(withTrailingSeparator(normalizedLeft));
}

function comparablePath(path) {
  const normalized = resolve(path).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function withTrailingSeparator(path) {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function isFileSystemRoot(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  return comparablePath(absolute) === comparablePath(root);
}

function boundaryError(code, message, reason) {
  return new ScratchBoundaryError(code, message, reason);
}
