import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const EXPECTED_SOURCE_BASELINE = '48a5a1f09ec29b02a01a9ee0410219947a349b16';

const ANCHORS = [
  ['apps/desktop/src/main/index.ts', ['createWindow', 'registerIpcHandlers', 'before-quit']],
  ['apps/desktop/src/main/ipc.ts', ['handle', 'assertTrustedSender', 'registerIpcHandlers', 'sessionCommitPort', 'disposeOperationLogUtility']],
  ['apps/desktop/src/main/ipc/registration.ts', ['TrustedIpcHandle']],
  ['apps/desktop/src/main/ipc/agent.ts', ['activeAgentRuns', 'pendingApprovals', 'runAgentSession', 'ai.agent.cancel']],
  ['apps/desktop/src/main/ipc/documents.ts', ['ensureEditorDocumentStore', 'deriveDocumentOwnerKey']],
  ['apps/desktop/src/main/operationLogUtilityClient.ts', ['pending', 'lateRequests', 'listIncompleteTransactions']],
  ['apps/desktop/src/main/operationLogUtilityProtocol.ts', ['health', 'close']],
  ['apps/desktop/src/main/ragEmbedding.ts', ['InternalRagEmbeddingService', 'schedule', 'startScheduledJob']],
  ['apps/desktop/src/main/workspaceStorage.ts', ['localApplicationDataRoot', 'resolveWorkspaceStoragePaths']],
  ['packages/core/src/bridge/runBridge.ts', ['runBridgeWithPool', 'resolveBridgeLaunch', 'disposeBridgeDaemonPool']],
  ['packages/core/src/bridge/bridgeDaemonClient.ts', ['start', 'request', 'dispose']],
  ['packages/core/src/transactions/index.ts', ['workspaceTransaction', 'resourceLockSet']],
  ['apps/desktop/electron.vite.config.ts', ['main', 'preload', 'externalizeDepsPlugin']],
  ['apps/desktop/electron-builder.json', ['files', 'extraResources', 'nsis']],
  ['scripts/verify-installer-lifecycle.mjs', ['runMode', 'report', 'runWithTimeout']],
  ['scripts/verify.mjs', ['tier']]
];

const SOURCE_FILES = [
  'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/main/auxiliaryServices.ts',
  'apps/desktop/src/preload/index.ts'
];

const CHANNEL_METHODS = new Set(['handle', 'on', 'send', 'invoke', 'postMessage']);
const DIRECT_WRITE_METHODS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'copyFile', 'copyFileSync']);
const PROCESS_METHODS = new Set(['spawn', 'spawnSync', 'fork', 'exec', 'execFile', 'execFileSync']);

export function scanIpcSource(files) {
  const channels = [];
  const unresolvedChannels = [];
  const asynchronousEntries = [];
  const parseDiagnostics = [];
  const constants = new Map();
  const identifiersByFile = new Map();

  for (const input of files) {
    const sourceFile = ts.createSourceFile(
      input.relativePath,
      input.sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(input.relativePath)
    );
    const identifiers = new Set();
    identifiersByFile.set(input.relativePath, identifiers);
    for (const diagnostic of sourceFile.parseDiagnostics) {
      parseDiagnostics.push({
        file: input.relativePath,
        line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      });
    }
    visit(sourceFile, node => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        constants.set(`${input.relativePath}:${node.name.text}`, node.initializer);
      }
    });
  }

  const resolveExpression = (expression, sourceFile, seen = new Set()) => {
    let current = expression;
    while (current && (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression?.(current)
    )) {
      current = current.expression;
    }
    if (!current) return null;
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveExpression(current.left, sourceFile, seen);
      const right = resolveExpression(current.right, sourceFile, seen);
      return left !== null && right !== null ? left + right : null;
    }
    if (ts.isIdentifier(current)) {
      const key = `${sourceFile.fileName}:${current.text}`;
      const initializer = constants.get(key);
      if (!initializer || seen.has(key)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      return resolveExpression(initializer, sourceFile, nextSeen);
    }
    return null;
  };

  for (const input of files) {
    const sourceFile = ts.createSourceFile(
      input.relativePath,
      input.sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(input.relativePath)
    );
    visit(sourceFile, node => {
      if (ts.isCallExpression(node)) {
        const access = propertyAccess(node.expression);
        if (access && CHANNEL_METHODS.has(access.method) && isIpcLikeOwner(access.owner)) {
          const argument = node.arguments[0];
          if (!argument) return;
          const channel = resolveExpression(argument, sourceFile);
          const location = locationOf(sourceFile, node);
          if (channel === null) {
            unresolvedChannels.push({
              file: input.relativePath,
              line: location.line,
              column: location.column,
              registrationKind: `${access.owner}.${access.method}`,
              expression: argument.getText(sourceFile).slice(0, 240)
            });
            return;
          }
          channels.push({
            channel,
            file: input.relativePath,
            line: location.line,
            column: location.column,
            registrationKind: `${access.owner}.${access.method}`
          });
        }
        const asyncEntry = classifyCall(node);
        if (asyncEntry) asynchronousEntries.push({ ...locationOf(sourceFile, node), file: input.relativePath, ...asyncEntry });
      }
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.VoidKeyword) {
        const location = locationOf(sourceFile, node);
        asynchronousEntries.push({
          file: input.relativePath,
          line: location.line,
          column: location.column,
          category: 'void-background-promise',
          symbol: node.operand.getText(sourceFile).slice(0, 160)
        });
      }
      if (ts.isVoidExpression?.(node)) {
        const location = locationOf(sourceFile, node);
        asynchronousEntries.push({
          file: input.relativePath,
          line: location.line,
          column: location.column,
          category: 'void-background-promise',
          symbol: node.expression.getText(sourceFile).slice(0, 160)
        });
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
        const location = locationOf(sourceFile, node);
        asynchronousEntries.push({
          file: input.relativePath,
          line: location.line,
          column: location.column,
          category: 'worker',
          symbol: 'Worker'
        });
      }
    });
  }

  const byChannel = new Map();
  for (const entry of channels) {
    const occurrences = byChannel.get(entry.channel) ?? [];
    occurrences.push(entry);
    byChannel.set(entry.channel, occurrences);
  }
  const duplicates = [...byChannel.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([channel, occurrences]) => ({ channel, occurrences }));

  const anchorPresence = new Map();
  for (const [file, names] of ANCHORS) {
    const identifiers = identifiersByFile.get(file) ?? new Set();
    anchorPresence.set(file, new Set(names.filter(name => identifiers.has(name))));
  }

  return {
    channels,
    duplicates,
    unresolvedChannels,
    asynchronousEntries: dedupeEntries(asynchronousEntries),
    parseDiagnostics,
    anchorPresence
  };
}

export async function inspectBaseline({ repoRoot = process.cwd(), outputRoot = join(repoRoot, 'output', 'update', 'U00') } = {}) {
  const root = resolve(repoRoot);
  const commandLog = [];
  const command = (program, args, { required = true } = {}) => {
    const result = spawnSync(program, args, {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    const record = {
      argv: [program, ...args],
      exitCode: result.status ?? 1,
      stdout: sanitizeText(result.stdout ?? '', root),
      stderr: sanitizeText(result.stderr ?? '', root)
    };
    commandLog.push(record);
    if (required && record.exitCode !== 0) return { ...record, failed: true };
    return record;
  };

  const topLevel = command('git', ['rev-parse', '--show-toplevel']);
  const head = command('git', ['rev-parse', 'HEAD']);
  const status = command('git', ['status', '--short']);
  const worktree = command('git', ['worktree', 'list', '--porcelain']);
  const nodeVersion = command(process.execPath, ['--version']);
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmVersion = command(process.execPath, [npmCli, '--version']);
  const dotnetInfo = command('dotnet', ['--info']);
  const dotnetVersion = command('dotnet', ['--version']);
  const gitVersion = command('git', ['--version']);

  const dirtyPaths = parseDirtyPaths(status.stdout);
  const sourceFiles = await loadSourceFiles(root);
  const scan = scanIpcSource(sourceFiles);
  const unresolvedAnchors = [];
  const anchorSources = await loadAnchorSources(root);
  for (const [file, names] of ANCHORS) {
    const present = anchorSources.get(file) ?? new Set();
    for (const name of names) {
      if (!present.has(name)) unresolvedAnchors.push({ file, symbol: name, reason: 'not-found-in-current-source' });
    }
  }
  for (const diagnostic of scan.parseDiagnostics) {
    unresolvedAnchors.push({ file: diagnostic.file, reason: 'typescript-parse-diagnostic', ...diagnostic });
  }
  for (const unresolved of scan.unresolvedChannels) {
    unresolvedAnchors.push({ reason: 'unresolved-channel-expression', ...unresolved });
  }
  if ((head.stdout ?? '').trim() !== EXPECTED_SOURCE_BASELINE) {
    unresolvedAnchors.push({
      code: 'SOURCE_BASELINE_DRIFT',
      expected: EXPECTED_SOURCE_BASELINE,
      actual: (head.stdout ?? '').trim() || null,
      reason: 'current-HEAD-differs-from-guidance-book-baseline'
    });
  }

  const keyFiles = {};
  for (const [file] of ANCHORS) {
    keyFiles[file] = {
      headBlobSha: gitBlob(command, file),
      workingTreeSha: fileDigest(root, file)
    };
  }

  const baseline = {
    schemaVersion: 1,
    taskId: 'U00',
    repository: '3516027002att-ui/SoulForge',
    headSha: (head.stdout ?? '').trim() || null,
    branch: currentBranch(command),
    dirtyPaths,
    dirtyPathCount: dirtyPaths.length,
    worktrees: parseWorktrees(worktree.stdout),
    tools: {
      git: firstLine(gitVersion.stdout),
      node: firstLine(nodeVersion.stdout),
      npm: firstLine(npmVersion.stdout),
      dotnet: firstLine(dotnetVersion.stdout)
    },
    commandLog: commandLog.map(({ argv, exitCode, stdout, stderr }) => ({ argv: redactArgv(argv, root), exitCode, stdout, stderr })),
    keyFiles,
    channels: scan.channels,
    duplicateChannels: scan.duplicates,
    unresolvedChannels: scan.unresolvedChannels,
    asynchronousEntries: scan.asynchronousEntries,
    unresolvedAnchors,
    status: commandLog.some(entry => entry.exitCode !== 0) ? 'blocked_environment' : 'source-inspection',
    generatedAt: new Date().toISOString()
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function propertyAccess(node) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  return {
    owner: node.expression.getText().split('.').at(-1) ?? '',
    method: node.name.text
  };
}

function isIpcLikeOwner(owner) {
  return owner === 'ipcMain' || owner === 'ipcRenderer' || owner === 'webContents' || owner === 'event';
}

function classifyCall(node) {
  const access = propertyAccess(node.expression);
  if (access && access.owner === 'Promise' && access.method === 'race') return { category: 'promise-race', symbol: 'Promise.race' };
  if (access && access.owner === 'fs' && DIRECT_WRITE_METHODS.has(access.method)) return { category: 'direct-file-write', symbol: `fs.${access.method}` };
  if (access && (access.owner === 'fsPromises' || access.owner === 'fsSync') && DIRECT_WRITE_METHODS.has(access.method)) return { category: 'direct-file-write', symbol: `${access.owner}.${access.method}` };
  if (access && (access.owner === 'database' || access.owner === 'db' || access.owner === 'sqlite') && /transaction|exec|prepare|run|close/i.test(access.method)) {
    return { category: 'sqlite-or-transaction', symbol: `${access.owner}.${access.method}` };
  }
  if (access && access.owner === 'childProcess' && PROCESS_METHODS.has(access.method)) return { category: 'child-process', symbol: `childProcess.${access.method}` };
  if (ts.isIdentifier(node.expression)) {
    if (node.expression.text === 'setTimeout' || node.expression.text === 'setInterval') return { category: 'timer', symbol: node.expression.text };
    if (DIRECT_WRITE_METHODS.has(node.expression.text)) return { category: 'direct-file-write', symbol: node.expression.text };
    if (PROCESS_METHODS.has(node.expression.text)) return { category: 'child-process', symbol: node.expression.text };
  }
  return null;
}

function locationOf(sourceFile, node) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const key = `${entry.file}:${entry.line}:${entry.column}:${entry.category}:${entry.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scriptKindForPath(file) {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
}

async function loadSourceFiles(root) {
  const paths = new Set(SOURCE_FILES);
  for (const directory of ['apps/desktop/src/main/ipc', 'apps/desktop/src/preload']) {
    const absolute = join(root, directory);
    let entries = [];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) paths.add(`${directory}/${entry.name}`);
    }
  }
  const files = [];
  for (const relativePath of paths) {
    try {
      files.push({ relativePath, sourceText: await readFile(join(root, relativePath), 'utf8') });
    } catch (error) {
      files.push({ relativePath, sourceText: '' });
    }
  }
  return files;
}

async function loadAnchorSources(root) {
  const sources = new Map();
  for (const [relativePath] of ANCHORS) {
    const absolutePath = join(root, relativePath);
    try {
      const sourceText = await readFile(absolutePath, 'utf8');
      if (relativePath.endsWith('.json')) {
        const parsed = JSON.parse(sourceText);
        const names = new Set(Object.keys(parsed));
        sources.set(relativePath, names);
        continue;
      }
      const sourceFile = ts.createSourceFile(
        relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        relativePath.endsWith('.mjs') ? ts.ScriptKind.JS : scriptKindForPath(relativePath)
      );
      const names = new Set();
      visit(sourceFile, node => {
        if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) names.add(node.text);
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const moduleName = node.moduleSpecifier.text.split('/').at(-1)?.replace(/\.[^.]+$/u, '');
          if (moduleName) names.add(moduleName);
        }
      });
      sources.set(relativePath, names);
    } catch {
      sources.set(relativePath, new Set());
    }
  }
  return sources;
}

function parseDirtyPaths(stdout) {
  return stdout.split(/\r?\n/u).filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
}

function parseWorktrees(stdout) {
  const records = [];
  let current = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { pathLabel: `worktree-${records.length + 1}`, headSha: null, branch: null };
    } else if (current && line.startsWith('HEAD ')) {
      current.headSha = line.slice(5).trim() || null;
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//u, '') || null;
    }
  }
  if (current) records.push(current);
  return records;
}

function currentBranch(command) {
  const result = command('git', ['branch', '--show-current']);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function gitBlob(command, relativePath) {
  const result = command('git', ['rev-parse', `HEAD:${relativePath}`], { required: false });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function fileDigest(root, relativePath) {
  try {
    const content = requireReadFileSync(join(root, relativePath));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function requireReadFileSync(path) {
  return Buffer.from(readFileSync(path));
}

function sanitizeText(value, root) {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  let text = String(value).replaceAll(root, '<repo>');
  if (userProfile) text = text.replaceAll(userProfile, '<user>');
  return text;
}

function redactArgv(argv, root) {
  return argv.map(value => sanitizeText(value, root));
}

function firstLine(value) {
  return String(value).split(/\r?\n/u).find(line => line.trim())?.trim() || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  inspectBaseline().then(baseline => {
    process.stdout.write(`${JSON.stringify({ taskId: 'U00', status: baseline.status, headSha: baseline.headSha, dirtyPathCount: baseline.dirtyPathCount, unresolvedAnchorCount: baseline.unresolvedAnchors.length, report: 'output/update/U00/baseline.json' }, null, 2)}\n`);
    if (baseline.status !== 'source-inspection') process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
