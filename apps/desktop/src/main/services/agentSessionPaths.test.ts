/**
 * ai.agent.sessions load/resume must not follow a junction / symbolic link out
 * of the physical sessions directory, and must hand back the checked physical
 * path so the later read cannot be redirected through the original alias.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAgentSessionPath } from './agentSessionPaths.js';

const NAME = 'rollout-2026-10-20T01-02-03-000Z-inside.jsonl';
const OUTSIDE_NAME = 'rollout-2026-10-21T01-02-03-000Z-outside.jsonl';

function withFixture(run: (paths: { base: string; outside: string; link(target: string, path: string): void }) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), 'sf-agent-session-paths-'));
  const links: string[] = [];
  try {
    const base = join(scratch, 'base');
    const outside = join(scratch, 'outside');
    mkdirSync(join(base, 'sessions', '2026', '10', '20'), { recursive: true });
    writeFileSync(join(base, 'sessions', '2026', '10', '20', NAME), '{}\n', 'utf8');
    mkdirSync(join(outside, '01', '02'), { recursive: true });
    writeFileSync(join(outside, OUTSIDE_NAME), '{}\n', 'utf8');
    writeFileSync(join(outside, 'legacy-outside.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(outside, '01', '02', 'legacy-outside.jsonl'), '{}\n', 'utf8');
    run({
      base,
      outside,
      link(target, path) {
        symlinkSync(target, path, 'junction');
        links.push(path);
      }
    });
  } finally {
    // Unlink aliases first so cleanup can never recurse into their targets.
    for (const link of links.reverse()) {
      try { unlinkSync(link); } catch { /* already gone */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const forbidden = { ok: false, error: { code: 'ROLLOUT_PATH_FORBIDDEN', message: '会话路径必须位于会话目录内。' } };

test('resolves session-relative paths and bare rollout names to the physical file', () => {
  withFixture(({ base }) => {
    const expected = realpathSync(join(base, 'sessions', '2026', '10', '20', NAME));
    assert.deepEqual(resolveAgentSessionPath(base, `sessions/2026/10/20/${NAME}`), { ok: true, absolute: expected });
    assert.deepEqual(resolveAgentSessionPath(base, NAME), { ok: true, absolute: expected });
  });
});

test('a session-relative path through a day-level junction outside sessions is forbidden', () => {
  withFixture(({ base, outside, link }) => {
    link(outside, join(base, 'sessions', '2026', '10', '21'));
    assert.deepEqual(resolveAgentSessionPath(base, `sessions/2026/10/21/${OUTSIDE_NAME}`), forbidden);
  });
});

test('a bare timestamped name resolved through a junction outside sessions is forbidden', () => {
  withFixture(({ base, outside, link }) => {
    link(outside, join(base, 'sessions', '2026', '10', '21'));
    assert.deepEqual(resolveAgentSessionPath(base, OUTSIDE_NAME), forbidden);
  });
});

test('the YYYY/MM/DD search does not walk through a year-level junction outside sessions', () => {
  withFixture(({ base, outside, link }) => {
    link(outside, join(base, 'sessions', '2025'));
    assert.deepEqual(resolveAgentSessionPath(base, 'legacy-outside.jsonl'), forbidden);
  });
});

test('sessions/ itself aliasing a directory outside the base is forbidden', () => {
  withFixture(({ base, outside, link }) => {
    rmSync(join(base, 'sessions'), { recursive: true, force: true });
    link(outside, join(base, 'sessions'));
    assert.deepEqual(resolveAgentSessionPath(base, OUTSIDE_NAME), forbidden);
  });
});

test('an alias that stays inside sessions resolves to its physical target', () => {
  withFixture(({ base, link }) => {
    link(join(base, 'sessions', '2026', '10', '20'), join(base, 'sessions', '2026', '10', '22'));
    assert.deepEqual(resolveAgentSessionPath(base, `sessions/2026/10/22/${NAME}`),
      { ok: true, absolute: realpathSync(join(base, 'sessions', '2026', '10', '20', NAME)) });
  });
});

test('lexical escapes and missing sessions keep structured errors', () => {
  withFixture(({ base }) => {
    assert.deepEqual(resolveAgentSessionPath(base, '../outside/legacy-outside.jsonl'), forbidden);
    const missing = resolveAgentSessionPath(base, 'rollout-2026-01-01T00-00-00-000Z-missing.jsonl');
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? undefined : missing.error.code, 'ROLLOUT_NOT_FOUND');
  });
});
