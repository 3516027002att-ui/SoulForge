/**
 * Production ToolRegistry PatchIR chain smoke.
 *
 * Verifies createDefaultToolRegistry() exposes and executes:
 * patch.proposeTextEdit → patch.stage → patch.validate → patch.commit → patch.rollback
 * through the shared patchTools implementation and policy gate.
 *
 * No frontend. No native parser/writer claims.
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-prod-patch-tools-'));
  const overlayRoot = join(root, 'mod');
  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  const notePath = join(overlayRoot, 'msg', 'note.txt');
  await writeFile(notePath, 'hello production\n', 'utf8');

  const registry = createDefaultToolRegistry();
  const names = new Set(registry.list().map((tool) => tool.name));
  for (const required of [
    'patch.proposeTextEdit',
    'patch.stage',
    'patch.validate',
    'patch.commit',
    'patch.rollback'
  ]) {
    if (!names.has(required)) throw new Error(`Missing production tool: ${required}`);
  }

  const index = new WorkspaceIndex('ws-prod-patch-tools');
  const state: Record<string, unknown> = {};
  const baseCtx = {
    workspaceIndex: index,
    mode: 'fullPermission' as const,
    workspaceRoot: overlayRoot,
    state
  };

  const propose = await registry.executeToolThroughPolicy(
    'patch.proposeTextEdit',
    {
      targetUri: 'soulforge://sekiro/overlay/msg/msg/note.txt',
      targetPath: 'msg/note.txt',
      newText: 'hello shared patch tools\n',
      title: 'production patch tools smoke'
    },
    baseCtx
  );
  if (!propose.ok) throw new Error(`propose failed: ${JSON.stringify(propose.error)}`);

  const stage = await registry.executeToolThroughPolicy('patch.stage', {}, baseCtx);
  if (!stage.ok) throw new Error(`stage failed: ${JSON.stringify(stage.error)}`);

  const validate = await registry.executeToolThroughPolicy('patch.validate', {}, baseCtx);
  if (!validate.ok) throw new Error(`validate failed: ${JSON.stringify(validate.error)}`);

  const commit = await registry.executeToolThroughPolicy('patch.commit', {}, baseCtx);
  if (!commit.ok) throw new Error(`commit failed: ${JSON.stringify(commit.error)}`);
  if ((await readFile(notePath, 'utf8')) !== 'hello shared patch tools\n') {
    throw new Error('commit did not write new text through production ToolRegistry.');
  }

  const rollback = await registry.executeToolThroughPolicy('patch.rollback', {}, baseCtx);
  if (!rollback.ok) throw new Error(`rollback failed: ${JSON.stringify(rollback.error)}`);
  if ((await readFile(notePath, 'utf8')) !== 'hello production\n') {
    throw new Error('rollback did not restore original text through production ToolRegistry.');
  }

  const denied = await registry.executeToolThroughPolicy(
    'patch.commit',
    {},
    {
      workspaceIndex: index,
      mode: 'plan',
      workspaceRoot: overlayRoot,
      state: {}
    }
  );
  if (denied.ok || denied.error?.code !== 'POLICY_DENIED') {
    throw new Error(`plan mode must deny patch.commit with POLICY_DENIED (got ${denied.error?.code ?? 'ok'}).`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'production patch tools smoke: ok',
    tools: registry.list().filter((tool) => tool.name.startsWith('patch.')).map((tool) => tool.name)
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
