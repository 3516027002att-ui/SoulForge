/**
 * Context Broker smoke — path allow/deny, junction escape, credential redaction,
 * absolute-path strip, and outbound audit item shape.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countSecretMatches,
  createContextBroker,
  prepareOutboundContext,
  stripAbsolutePaths
} from '../ai/contextBroker.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CONTEXT_BROKER_SMOKE_FAIL: ${message}`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-context-broker-'));
  const overlay = join(root, 'mod');
  const base = join(root, 'game');
  const appData = join(root, 'app-data');
  const backups = join(root, 'backups');
  const staging = join(root, 'staging');
  const outside = join(root, 'outside');
  await mkdir(join(overlay, 'event'), { recursive: true });
  await mkdir(join(base, 'event'), { recursive: true });
  await mkdir(appData, { recursive: true });
  await mkdir(backups, { recursive: true });
  await mkdir(staging, { recursive: true });
  await mkdir(outside, { recursive: true });

  const overlayFile = join(overlay, 'event', 'common.emevd.dcx');
  const baseFile = join(base, 'event', 'common.emevd.dcx');
  const appDataFile = join(appData, 'app.db');
  const backupFile = join(backups, 'op-1.bin');
  const stagingFile = join(staging, 'staged.bin');
  const outsideFile = join(outside, 'secret.txt');
  await writeFile(overlayFile, 'overlay-body', 'utf8');
  await writeFile(baseFile, 'base-body', 'utf8');
  await writeFile(appDataFile, 'db', 'utf8');
  await writeFile(backupFile, 'backup', 'utf8');
  await writeFile(stagingFile, 'staging', 'utf8');
  await writeFile(outsideFile, 'outside', 'utf8');

  const junctionTarget = join(overlay, 'escape-link');
  let junctionCreated = false;
  try {
    await symlink(outside, junctionTarget, 'junction');
    junctionCreated = true;
  } catch {
    // Some CI images disallow junctions; path tests still cover lexical deny.
    junctionCreated = false;
  }

  try {
    assert(countSecretMatches('key sk-abcdefghijklmnopqrstuvwxyz012345') === 1, 'secret match count');
    const stripped = stripAbsolutePaths(
      `path=${overlayFile}; key=sk-abcdefghijklmnopqrstuvwxyz012345`,
      { overlayRoot: overlay, baseRoot: base, forbiddenRoots: [appData, backups] }
    );
    assert(!stripped.includes(overlayFile), 'strip removes overlay absolute path');
    assert(stripped.includes('<workspace-root>') || stripped.includes('<absolute-path>'), 'path placeholder');

    const prepared = await prepareOutboundContext({
      modelServiceId: 'svc-1',
      agentRunId: 'run-1',
      sentAt: '2026-07-16T00:00:00.000Z',
      roots: {
        overlayRoot: overlay,
        baseRoot: base,
        forbiddenRoots: [appData, backups]
      },
      candidates: [
        {
          contextKind: 'user-prompt',
          content: `分析 ${overlayFile}，token=sk-abcdefghijklmnopqrstuvwxyz012345`,
          layer: 'overlay'
        },
        {
          contextKind: 'resource-excerpt',
          absolutePath: overlayFile,
          content: 'event body',
          metadata: { absolutePath: overlayFile, note: 'ok' }
        },
        {
          contextKind: 'resource-excerpt',
          absolutePath: baseFile,
          content: 'vanilla body'
        },
        {
          contextKind: 'workspace-session',
          content: JSON.stringify({ workspaceSessionId: 'ws-1' }),
          layer: 'overlay'
        },
        {
          contextKind: 'forbidden-app-data',
          absolutePath: appDataFile,
          content: 'should-not-send'
        },
        {
          contextKind: 'forbidden-backup',
          absolutePath: backupFile,
          content: 'should-not-send'
        },
        {
          contextKind: 'outside-workspace',
          absolutePath: outsideFile,
          content: 'should-not-send'
        },
        ...(junctionCreated
          ? [{
              contextKind: 'junction-escape',
              absolutePath: join(junctionTarget, 'secret.txt'),
              content: 'should-not-send'
            }]
          : [])
      ]
    });

    assert(prepared.agentRunId === 'run-1', 'agent run id preserved');
    assert(prepared.modelServiceId === 'svc-1', 'service id preserved');
    assert(prepared.sentAt === '2026-07-16T00:00:00.000Z', 'sentAt preserved');
    assert(prepared.items.length === 4, `expected 4 accepted items, got ${prepared.items.length}`);
    assert(prepared.rejected.length >= 3, `expected >=3 rejections, got ${prepared.rejected.length}`);
    assert(prepared.ok === false, 'ok false when any rejection');

    const prompt = prepared.items.find((item) => item.contextKind === 'user-prompt');
    assert(prompt, 'user prompt accepted');
    assert(!prompt!.payload.content.includes('sk-'), 'prompt secrets redacted');
    assert(!prompt!.payload.content.includes(overlayFile), 'prompt absolute path stripped');
    assert(prompt!.redactionSummary.credentialsRemoved, 'prompt credentialsRemoved');
    assert(prompt!.redactionSummary.byteCount === Buffer.byteLength(prompt!.payload.content, 'utf8'), 'byteCount');
    assert(prompt!.contentHash === createHash('sha256').update(prompt!.payload.content).digest('hex'), 'hash');

    const overlayItem = prepared.items.find((item) => item.payload.relativePath === 'event/common.emevd.dcx' && item.payload.layer === 'overlay');
    assert(overlayItem, 'overlay resource accepted');
    assert(overlayItem!.resourceUri === 'file://event/common.emevd.dcx', 'resource uri');
    assert(overlayItem!.payload.metadata && !JSON.stringify(overlayItem!.payload.metadata).includes(overlayFile), 'metadata paths stripped');

    const baseItem = prepared.items.find((item) => item.payload.layer === 'base');
    assert(baseItem, 'base resource accepted');

    const rejectCodes = new Set(prepared.rejected.map((item) => item.code));
    assert(rejectCodes.has('CONTEXT_PATH_FORBIDDEN_ROOT'), 'app data / backup forbidden');
    assert(rejectCodes.has('CONTEXT_PATH_OUTSIDE_WORKSPACE') || rejectCodes.has('CONTEXT_JUNCTION_ESCAPE'), 'outside denied');
    if (junctionCreated) {
      assert(
        prepared.rejected.some((item) => item.contextKind === 'junction-escape'),
        'junction escape rejected'
      );
    }

    // Broker helper API
    const broker = createContextBroker({
      overlayRoot: overlay,
      baseRoot: base,
      forbiddenRoots: [appData, backups]
    });
    const allowed = await broker.isPathAllowed(overlayFile);
    assert(allowed.allowed && allowed.layer === 'overlay', 'broker isPathAllowed overlay');
    const denied = await broker.isPathAllowed(appDataFile);
    assert(!denied.allowed && denied.code === 'CONTEXT_PATH_FORBIDDEN_ROOT', 'broker denies app data');

    // Pure allow-only batch remains ok=true
    const clean = await prepareOutboundContext({
      modelServiceId: 'svc-1',
      roots: { overlayRoot: overlay, baseRoot: base, forbiddenRoots: [appData, backups] },
      candidates: [
        { contextKind: 'workspace-session', content: '{"id":"ws"}', layer: 'overlay' }
      ]
    });
    assert(clean.ok && clean.rejected.length === 0 && clean.outboundContextItems.length === 1, 'clean batch ok');
    const auditItem = clean.outboundContextItems[0]!;
    const summary = auditItem.redactionSummary as { modelServiceId?: string; agentRunId?: string; sentAt?: string; byteCount?: number };
    assert(summary.modelServiceId === 'svc-1', 'audit embeds service id');
    assert(typeof summary.agentRunId === 'string' && summary.agentRunId.length > 0, 'audit embeds run id');
    assert(typeof summary.sentAt === 'string', 'audit embeds sentAt');
    assert(typeof summary.byteCount === 'number', 'audit embeds byteCount');

    console.log(JSON.stringify({
      ok: true,
      accepted: prepared.items.length,
      rejected: prepared.rejected.length,
      junctionCreated,
      totalOutboundBytes: prepared.audit.totalOutboundBytes
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
