import type { RuntimeProcessHost } from './me3RuntimeAdapter.js';

export interface Me3ExecutableProbeOptions {
  processHost: RuntimeProcessHost;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface Me3ExecutableProbeResult {
  ok: boolean;
  version?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  reason?: string;
}

/**
 * Verify that a user-selected file behaves like the me3 CLI before it becomes
 * launch authority. File existence alone is insufficient: any executable could
 * otherwise be persisted as me3.
 */
export async function probeMe3Executable(
  options: Me3ExecutableProbeOptions
): Promise<Me3ExecutableProbeResult> {
  const maxOutputBytes = Math.max(1_024, options.maxOutputBytes ?? 64 * 1_024);
  const timeoutMs = Math.max(250, options.timeoutMs ?? 5_000);
  const stdout = new ProbeTextBuffer(maxOutputBytes);
  const stderr = new ProbeTextBuffer(maxOutputBytes);
  const handle = options.processHost.spawn(options.command, ['info'], {
    cwd: options.cwd,
    env: options.env
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Me3ExecutableProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    handle.onStdout((chunk) => stdout.append(chunk));
    handle.onStderr((chunk) => stderr.append(chunk));
    handle.onError((error) => finish({
      ok: false,
      stdout: stdout.value(),
      stderr: stderr.value(),
      reason: `probe-spawn-failed: ${error.message}`
    }));
    handle.onExit((code, signal) => {
      const stdoutText = stdout.value();
      const stderrText = stderr.value();
      const combined = `${stdoutText}\n${stderrText}`;
      if (code !== 0) {
        finish({
          ok: false,
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }),
          stdout: stdoutText,
          stderr: stderrText,
          reason: `me3 info exited unsuccessfully${code === null ? '' : ` (${code})`}`
        });
        return;
      }
      if (!/\bme3\b/i.test(combined)) {
        finish({
          ok: false,
          exitCode: 0,
          stdout: stdoutText,
          stderr: stderrText,
          reason: 'me3 identity marker was not present in `me3 info` output'
        });
        return;
      }
      const version = extractVersion(combined);
      finish({
        ok: true,
        exitCode: 0,
        ...(version ? { version } : {}),
        stdout: stdoutText,
        stderr: stderrText
      });
    });

    const timer = setTimeout(() => {
      handle.kill('SIGTERM');
      finish({
        ok: false,
        stdout: stdout.value(),
        stderr: stderr.value(),
        reason: `me3 info timed out after ${timeoutMs} ms`
      });
    }, timeoutMs);
  });
}

function extractVersion(value: string): string | undefined {
  const me3Version = value.match(/\bme3\b[^0-9]{0,24}v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  if (me3Version?.[1]) return me3Version[1];
  const genericVersion = value.match(/\bversion\b[^0-9]{0,16}v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  return genericVersion?.[1];
}

class ProbeTextBuffer {
  private valueText = '';

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array | string): void {
    this.valueText += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const bytes = Buffer.byteLength(this.valueText, 'utf8');
    if (bytes <= this.maxBytes) return;
    const encoded = Buffer.from(this.valueText, 'utf8');
    this.valueText = encoded.subarray(encoded.length - this.maxBytes).toString('utf8');
  }

  value(): string {
    return this.valueText;
  }
}
