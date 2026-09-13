import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Only expand portable commands we can execute without a shell. Unsupported
// syntax stays inside npm, including its lifecycle hooks and shell semantics.
export function tokenizeCommands(command) {
  const segments = [[]];
  let token = '';
  let quoted = false;
  let started = false;
  const flush = () => {
    if (started) segments.at(-1).push(token);
    token = ''; started = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (/[`$%\r\n]/.test(ch) || ch === "'") return null;
    if (!quoted && ch === '&' && command[i + 1] === '&') {
      flush();
      if (!segments.at(-1).length) return null;
      segments.push([]); i += 1; continue;
    }
    if (!quoted && /[|&;<>^()]/.test(ch)) return null;
    if (!quoted && /\s/.test(ch)) { flush(); continue; }
    if (ch === '\\' && command[i + 1] === '"') return null;
    token += ch; started = true;
  }
  flush();
  return quoted || segments.some((s) => !s.length) ? null : segments;
}

export function parseNpmForward(tokens) {
  if (tokens[0] !== 'npm' || !['run', 'run-script'].includes(tokens[1]) || !tokens[2]) return null;
  const result = { script: tokens[2], workspace: null, args: [] };
  for (let i = 3; i < tokens.length; i += 1) {
    const value = tokens[i];
    if (value === '--') { result.args = tokens.slice(i + 1); break; }
    if (value === '--workspaces' || value === '--ws') { result.workspaces = true; continue; }
    if (value === '--if-present') { result.ifPresent = true; continue; }
    if (value === '--silent') continue;
    if (value === '-w' || value === '--workspace') {
      if (result.workspace !== null || !tokens[i + 1]) return null;
      result.workspace = tokens[++i]; continue;
    }
    if (value.startsWith('--workspace=')) {
      if (result.workspace !== null) return null;
      result.workspace = value.slice('--workspace='.length); continue;
    }
    return null;
  }
  if (result.workspace !== null && result.workspaces) return null;
  return result;
}

export function forwardTargets(workspaces, forward, currentDir = '') {
  if (forward.workspaces) return [...workspaces.byName.values()];
  if (forward.workspace !== null) {
    const target = workspaces.byName.get(forward.workspace)
      ?? (workspaces.byDir.has(forward.workspace)
        ? { dir: forward.workspace, ...workspaces.byDir.get(forward.workspace) } : null);
    if (!target) throw new Error(`Unknown workspace: ${forward.workspace}`);
    return [target];
  }
  return [{ dir: currentDir, scripts: currentDir ? workspaces.byDir.get(currentDir).scripts : workspaces.rootScripts }];
}

export function operationKey(operation) {
  return createHash('sha256').update(JSON.stringify([
    operation.cwd, operation.command, operation.args,
    Object.entries(operation.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    operation.kind
  ])).digest('hex').slice(0, 20);
}

function isDirectNodeScript(tokens) {
  if (tokens[0] !== 'node') return false;
  const flags = new Set(['--experimental-strip-types', '--enable-source-maps', '--no-warnings']);
  let index = 1;
  while (flags.has(tokens[index])) index += 1;
  return Boolean(tokens[index] && !tokens[index].startsWith('-') && /\.(?:mjs|cjs|js|ts)$/.test(tokens[index]));
}

export function planScript(repoRoot, workspaces, scriptName, { args = [], env = {} } = {}) {
  const stack = new Set();
  const operation = (cwd, command, commandArgs, owner, kind) => {
    const value = { cwd: resolve(repoRoot, cwd), command, args: commandArgs, env, owner, kind };
    return { ...value, key: operationKey(value) };
  };
  const walk = (name, dir, scripts, extraArgs = []) => {
    const id = `${dir || '.'}:${name}`;
    if (stack.has(id)) throw new Error(`Npm script cycle: ${[...stack, id].join(' -> ')}`);
    if (typeof scripts[name] !== 'string') throw new Error(`Missing npm script: ${id}`);
    // Builds, generators and lifecycle scripts may mutate the inputs of earlier
    // tests. Keep them as barriers; do not reuse test evidence across them.
    const kind = name.startsWith('test') || name === 'verify:audit' || name === 'handoff:fingerprint'
      ? 'test' : name === 'typecheck' ? 'prepare' : 'barrier';
    const opaque = () => [operation(dir, 'npm', ['run', name, '--silent', ...(extraArgs.length ? ['--', ...extraArgs] : [])], id, 'barrier')];
    const segments = tokenizeCommands(scripts[name]);
    if (scripts[`pre${name}`] || scripts[`post${name}`] || !segments
      || (extraArgs.length > 0 && segments.length !== 1) || kind === 'barrier') return opaque();
    stack.add(id);
    const steps = [];
    try {
      for (const originalTokens of segments) {
        const tokens = [...originalTokens, ...extraArgs];
        if (isDirectNodeScript(tokens)) {
          steps.push(operation(dir, 'node', tokens.slice(1), id, kind));
        } else if (tokens[0] === 'tsc') {
          steps.push(operation(dir, 'tsc', tokens.slice(1), id, 'prepare'));
        } else {
          const forward = parseNpmForward(tokens);
          if (!forward) return opaque();
          for (const target of forwardTargets(workspaces, forward, dir)) {
            if (forward.ifPresent && !(forward.script in target.scripts)) continue;
            steps.push(...walk(forward.script, target.dir, target.scripts, forward.args));
          }
        }
      }
      // An empty --if-present group has no execution evidence. Let npm report it;
      // the normal empty-output classifier will keep it from becoming PASS.
      return steps.length ? steps : opaque();
    } finally { stack.delete(id); }
  };
  return walk(scriptName, '', workspaces.rootScripts, args);
}

export function summarizePlan(suites) {
  const seen = new Set();
  let occurrences = 0;
  let uniqueOperations = 0;
  let reusableOccurrences = 0;
  for (const suite of suites) {
    for (const step of suite.steps) {
      occurrences += 1;
      if (step.kind === 'barrier') seen.clear();
      if (seen.has(step.key)) reusableOccurrences += 1;
      else uniqueOperations += 1;
      if (step.kind !== 'barrier') seen.add(step.key);
    }
  }
  return { occurrences, uniqueOperations, reusableOccurrences };
}
