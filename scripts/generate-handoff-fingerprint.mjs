#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { computeHandoffFingerprintSha256 } from './handoff-integrity-lib.mjs';

const SCHEMA_VERSION = 1;
const HANDOFF_PATH = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
const EXCLUDED_PATHS = [HANDOFF_PATH];

class FingerprintError extends Error {
  constructor(code, operation, message, details = {}) {
    super(message);
    this.name = 'FingerprintError';
    this.code = code;
    this.operation = operation;
    this.details = details;
  }
}

function decodeOutput(bytes) {
  return bytes.toString('utf8').trim();
}

function runGit(args, { cwd, operation, onStdout } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    child.stdout.on('data', (chunk) => {
      if (onStdout) onStdout(chunk);
      else stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(new FingerprintError(
        'GIT_EXEC_FAILED',
        operation,
        'Unable to start Git.',
        { causeCode: error.code ?? 'UNKNOWN' }
      ));
    });

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      const stderr = decodeOutput(Buffer.concat(stderrChunks));
      if (exitCode !== 0) {
        rejectPromise(new FingerprintError(
          'GIT_COMMAND_FAILED',
          operation,
          'Git command failed.',
          {
            exitCode,
            signal: signal ?? null,
            ...(stderr ? { gitStderr: stderr } : {})
          }
        ));
        return;
      }
      resolvePromise(Buffer.concat(stdoutChunks));
    });
  });
}

async function hashGitOutput(args, options) {
  const hash = createHash('sha256');
  await runGit(args, {
    ...options,
    onStdout: (chunk) => hash.update(chunk)
  });
  return hash.digest('hex');
}

function repositoryPath(repoRoot, repoRelativePath) {
  const absolutePath = resolve(repoRoot, ...repoRelativePath.split('/'));
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new FingerprintError(
      'UNTRACKED_PATH_OUTSIDE_REPOSITORY',
      'hash-untracked-file',
      'Git returned a path outside the repository.',
      { path: repoRelativePath }
    );
  }
  return absolutePath;
}

function hashFile(repoRoot, repoRelativePath, operation) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(repositoryPath(repoRoot, repoRelativePath));

    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', (error) => {
      rejectPromise(new FingerprintError(
        'FILE_READ_FAILED',
        operation,
        'Unable to read a repository-relative file.',
        {
          path: repoRelativePath,
          causeCode: error.code ?? 'UNKNOWN'
        }
      ));
    });
    stream.once('end', () => {
      resolvePromise({ size, sha256: hash.digest('hex') });
    });
  });
}

function parseNullTerminatedPaths(output) {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) {
    throw new FingerprintError(
      'GIT_OUTPUT_INVALID',
      'list-untracked-files',
      'Git returned a non-NUL-terminated untracked path list.'
    );
  }

  return output
    .subarray(0, -1)
    .toString('utf8')
    .split('\0')
    .map((path) => path.replaceAll('\\', '/'))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function hashUntrackedManifest(repoRoot, verbose) {
  const output = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, operation: 'list-untracked-files' }
  );
  const paths = parseNullTerminatedPaths(output);
  const manifestHash = createHash('sha256');
  const entries = verbose ? [] : null;

  for (const path of paths) {
    const file = await hashFile(repoRoot, path, 'hash-untracked-file');
    manifestHash.update(Buffer.from(path, 'utf8'));
    manifestHash.update('\0');
    manifestHash.update(String(file.size));
    manifestHash.update('\0');
    manifestHash.update(file.sha256);
    manifestHash.update('\0');
    if (entries) entries.push({ path, size: file.size, sha256: file.sha256 });
  }

  return {
    sha256: manifestHash.digest('hex'),
    count: paths.length,
    entries
  };
}

function parseArguments(args) {
  const invalid = args.filter((arg) => arg !== '--verbose');
  if (invalid.length > 0) {
    throw new FingerprintError(
      'ARGUMENT_INVALID',
      'parse-arguments',
      'Only the optional --verbose argument is supported.',
      { arguments: invalid }
    );
  }
  return { verbose: args.includes('--verbose') };
}

function writeFailure(error) {
  const known = error instanceof FingerprintError;
  const payload = {
    ok: false,
    error: {
      code: known ? error.code : 'UNEXPECTED_ERROR',
      operation: known ? error.operation : 'generate-fingerprint',
      message: known ? error.message : 'Unexpected fingerprint generation failure.',
      ...(known ? error.details : {})
    }
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}

async function main() {
  const { verbose } = parseArguments(process.argv.slice(2));
  const rootOutput = await runGit(
    ['rev-parse', '--show-toplevel'],
    { cwd: process.cwd(), operation: 'resolve-repository-root' }
  );
  const repoRoot = resolve(decodeOutput(rootOutput));
  const headOutput = await runGit(
    ['rev-parse', '--verify', 'HEAD'],
    { cwd: repoRoot, operation: 'resolve-head' }
  );
  const head = decodeOutput(headOutput);
  const handoff = await hashFile(repoRoot, HANDOFF_PATH, 'hash-handoff-before-evidence-append');
  const trackedDiffSha256 = await hashGitOutput(
    [
      '-c', 'core.quotepath=true',
      'diff',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--diff-algorithm=myers',
      '--unified=3',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'HEAD',
      '--',
      '.',
      `:(top,exclude)${HANDOFF_PATH}`
    ],
    { cwd: repoRoot, operation: 'hash-tracked-diff' }
  );
  const untracked = await hashUntrackedManifest(repoRoot, verbose);

  const fingerprintFields = {
    head,
    trackedDiffSha256,
    untrackedManifestSha256: untracked.sha256,
    handoffSha256BeforeEvidenceAppend: handoff.sha256
  };
  const result = {
    schemaVersion: SCHEMA_VERSION,
    ...fingerprintFields,
    fingerprintSha256: computeHandoffFingerprintSha256(fingerprintFields),
    untrackedCount: untracked.count,
    excludedPaths: EXCLUDED_PATHS,
    ...(verbose ? { untrackedEntries: untracked.entries } : {})
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(writeFailure);
