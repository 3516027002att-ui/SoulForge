/**
 * SessionFeedbackService uploads rollout traces by the lexical path that
 * listRolloutSessions returned. A day directory swapped for a junction after
 * listing must not redirect the upload read outside the sessions directory.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { SessionFeedbackService, type FeedbackUploadEnvelope } from './sessionFeedback.js';

const meta = (sessionId: string) => `${JSON.stringify({ type: 'session-meta', meta: { sessionId, startedAt: '2026-10-20T00:00:00.000Z' } })}\n`;

it('does not upload a file outside sessions/ when a day directory is swapped after listing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'sf-feedback-boundary-'));
  const links: string[] = [];
  try {
    const base = join(scratch, 'base');
    const dayA = join(base, 'sessions', '2026', '10', '20');
    const dayB = join(base, 'sessions', '2026', '10', '21');
    const outside = join(scratch, 'outside');
    await mkdir(dayA, { recursive: true });
    await mkdir(dayB, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(dayA, 'rollout-a.jsonl'), meta('session-a'), 'utf8');
    await writeFile(join(dayB, 'rollout-b.jsonl'), meta('session-b'), 'utf8');
    await writeFile(join(outside, 'rollout-b.jsonl'), `${meta('session-b')}OUTSIDE-SECRET-MARKER\n`, 'utf8');
    // Newest first: session-a is uploaded first, session-b second.
    await utimes(join(dayB, 'rollout-b.jsonl'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const uploads: FeedbackUploadEnvelope[] = [];
    let swapped = false;
    const service = new SessionFeedbackService(base, {
      async submit(payload) {
        uploads.push(payload);
        if (!swapped) {
          // Between listing and reading session-b: replace its day directory with a junction.
          swapped = true;
          await rename(dayB, join(base, 'sessions', '2026', '10', 'moved'));
          await symlink(outside, dayB, 'junction');
          links.push(dayB);
        }
        return { ok: true };
      }
    } as ConstructorParameters<typeof SessionFeedbackService>[1], { appVersion: 'test' });

    const result = await service.submitAllHistory();
    assert.equal(swapped, true);
    assert.ok(!JSON.stringify(uploads).includes('OUTSIDE-SECRET-MARKER'), 'upload read followed the swapped junction outside sessions/');
    assert.deepEqual(result.failedSessions, [{ sessionId: 'session-b', code: 'TRACE_READ_FAILED' }]);
    assert.equal(result.uploadedSessions, 1);
  } finally {
    for (const link of links) await unlink(link).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
});
