/**
 * listRolloutSessions must not follow a junction / symbolic link out of the
 * physical sessions directory (directory levels, files, or sessions/ itself).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { listRolloutSessions } from './fileRolloutStorage.js';

async function withFixture(run: (paths: { base: string; outside: string; links: string[] }) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'sf-rollout-boundary-'));
  const links: string[] = [];
  try {
    const base = join(scratch, 'base');
    const outside = join(scratch, 'outside');
    await mkdir(join(base, 'sessions', '2026', '10', '20'), { recursive: true });
    await writeFile(join(base, 'sessions', '2026', '10', '20', 'rollout-inside.jsonl'), '{}\n', 'utf8');
    await mkdir(join(outside, '2026', '10', '21'), { recursive: true });
    await writeFile(join(outside, 'rollout-outside.jsonl'), '{}\n', 'utf8');
    await writeFile(join(outside, '2026', '10', '21', 'rollout-outside-tree.jsonl'), '{}\n', 'utf8');
    // MM/DD layout so a year-level alias reaches a .jsonl at the walk's file depth.
    await mkdir(join(outside, '10', '22'), { recursive: true });
    await writeFile(join(outside, '10', '22', 'rollout-outside-year.jsonl'), '{}\n', 'utf8');
    await run({ base, outside, links });
  } finally {
    // Unlink aliases first so cleanup can never recurse into their targets.
    for (const link of links) await unlink(link).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

it('lists sessions physically inside the sessions directory', async () => {
  await withFixture(async ({ base }) => {
    const listed = await listRolloutSessions(base);
    assert.deepEqual(listed.map((item) => item.fileName), ['rollout-inside.jsonl']);
  });
});

it('does not follow a day-level junction out of the sessions directory', async () => {
  await withFixture(async ({ base, outside, links }) => {
    const link = join(base, 'sessions', '2026', '10', '21');
    await symlink(outside, link, 'junction');
    links.push(link);
    const listed = await listRolloutSessions(base);
    assert.deepEqual(listed.map((item) => item.fileName), ['rollout-inside.jsonl']);
  });
});

it('does not follow a year-level junction out of the sessions directory', async () => {
  await withFixture(async ({ base, outside, links }) => {
    const link = join(base, 'sessions', '2025');
    await symlink(outside, link, 'junction');
    links.push(link);
    const listed = await listRolloutSessions(base);
    assert.deepEqual(listed.map((item) => item.fileName), ['rollout-inside.jsonl']);
  });
});

it('returns nothing when sessions/ itself aliases a directory outside the base', async () => {
  await withFixture(async ({ base, outside, links }) => {
    await rm(join(base, 'sessions'), { recursive: true, force: true });
    const link = join(base, 'sessions');
    await symlink(outside, link, 'junction');
    links.push(link);
    assert.deepEqual(await listRolloutSessions(base), []);
  });
});
