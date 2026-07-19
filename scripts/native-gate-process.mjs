import { spawn } from 'node:child_process';

export function runNativeGateCommand(command, args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const invocation = resolveInvocation(command, args);
    let child;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolvePromise({
        code: 1,
        stdout: '',
        stderr: '',
        spawnErrorCode: nodeErrorCode(error)
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code: 1,
        exitCode: 1,
        stdout,
        stderr,
        spawnErrorCode: nodeErrorCode(error)
      });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      const exitCode = Number.isInteger(code) ? code : 1;
      resolvePromise({ code: exitCode, exitCode, stdout, stderr, spawnErrorCode: null });
    });
  });
}

function resolveInvocation(command, args) {
  if (process.platform === 'win32' && command === 'npm') {
    return {
      executable: process.env.ComSpec?.trim() || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', ...args]
    };
  }
  return { executable: command, args };
}

function nodeErrorCode(error) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'UNKNOWN';
}
