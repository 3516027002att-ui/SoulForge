import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  commitWithKnowledgeRefresh,
  runCallerOwnedPostCommit,
  type KnowledgeRefreshOwner
} from './knowledgeRefreshOwnership.js';

declare const __SOULFORGE_REPO_ROOT__: string;
const readSource = (...parts: string[]): string => readFileSync(
  join(__SOULFORGE_REPO_ROOT__, ...parts),
  'utf8'
);

type MockResult = { ok: boolean; marker: string; refreshStatus?: 'converged' | 'failed' };

async function runMockCommit(
  result: MockResult,
  owner: KnowledgeRefreshOwner,
  events: string[],
  refresh: (result: MockResult) => Promise<unknown>
): Promise<MockResult> {
  return commitWithKnowledgeRefresh(
    async () => {
      events.push('commit');
      return result;
    },
    owner,
    async (_result) => {
      events.push('refresh');
      return refresh(_result);
    }
  );
}

describe('knowledge refresh ownership', () => {
  it('default port owner refreshes one successful commit exactly once', async () => {
    const events: string[] = [];
    const result = await runMockCommit(
      { ok: true, marker: 'committed' },
      'port',
      events,
      async () => undefined
    );
    assert.equal(result.marker, 'committed');
    assert.deepEqual(events, ['commit', 'refresh']);
  });

  it('port owner does not refresh failed or cancelled results', async () => {
    for (const marker of ['failed', 'cancelled']) {
      const events: string[] = [];
      const result = await runMockCommit(
        { ok: false, marker },
        'port',
        events,
        async () => undefined
      );
      assert.equal(result.marker, marker);
      assert.deepEqual(events, ['commit']);
    }
  });

  it('caller owner leaves one refresh to the caller after cache invalidation', async () => {
    const events: string[] = [];
    const result = await runMockCommit({ ok: true, marker: 'committed' }, 'caller', events, async () => undefined);
    assert.equal(result.marker, 'committed');
    assert.deepEqual(events, ['commit']);

    await runCallerOwnedPostCommit(result, {
      prepare: () => { events.push('cache-clear'); },
      refresh: async (value) => {
        events.push('refresh');
        value.refreshStatus = 'converged';
        return { status: 'converged' };
      }
    });
    assert.deepEqual(events, ['commit', 'cache-clear', 'refresh']);
    assert.equal(result.refreshStatus, 'converged');
  });

  it('preview rejection still performs exactly one caller refresh and preserves commit ok', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const committed: MockResult = { ok: true, marker: 'committed' };
    const result = await runCallerOwnedPostCommit(
      committed,
      {
        prepare: async () => {
          events.push('preview');
          throw new Error('preview failed');
        },
        refresh: async (value) => {
          events.push('refresh');
          value.refreshStatus = 'failed';
          return { status: 'failed' };
        },
        onPrepareError: (_result, error) => errors.push(error)
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.refreshStatus, 'failed');
    assert.deepEqual(events, ['preview', 'refresh']);
    assert.equal(errors.length, 1);
  });

  it('caller refresh rejection is not retried or allowed to overwrite commit ok', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const result = await runCallerOwnedPostCommit(
      { ok: true, marker: 'committed' },
      {
        prepare: () => { events.push('cache-clear'); },
        refresh: async () => {
          events.push('refresh');
          throw new Error('refresh failed');
        },
        onRefreshError: (_result, error) => errors.push(error)
      }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(events, ['cache-clear', 'refresh']);
    assert.equal(errors.length, 1);
  });

  it('caller post-commit sequence does not run for failed or cancelled results', async () => {
    for (const marker of ['failed', 'cancelled']) {
      const events: string[] = [];
      const result = await runCallerOwnedPostCommit(
        { ok: false, marker },
        {
          prepare: () => { events.push('cache-clear'); },
          refresh: async () => {
            events.push('refresh');
          }
        }
      );
      assert.equal(result.marker, marker);
      assert.deepEqual(events, []);
    }
  });

  it('refresh rejection is not retried and never overwrites a committed result', async () => {
    const events: string[] = [];
    let refreshError: unknown;
    const result = await runMockCommit(
      { ok: true, marker: 'committed' },
      'port',
      events,
      async () => {
        throw new Error('refresh failed');
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.marker, 'committed');
    assert.deepEqual(events, ['commit', 'refresh']);
    // The helper's error hook is covered by the production adapter below;
    // a rejected refresh never becomes a second commit or retry.
    await commitWithKnowledgeRefresh(
      async () => result,
      'port',
      async () => { throw new Error('refresh failed'); },
      (_result, error) => { refreshError = error; }
    );
    assert.equal(refreshError instanceof Error && refreshError.message, 'refresh failed');
    assert.equal(result.marker, 'committed');
  });

  it('keeps caller ownership explicit and leaves assets on the default port owner', () => {
    const param = readSource('apps', 'desktop', 'src', 'main', 'ipc', 'param.ts');
    const event = readSource('apps', 'desktop', 'src', 'main', 'ipc', 'event.ts');
    const text = readSource('apps', 'desktop', 'src', 'main', 'ipc', 'text.ts');
    const assets = readSource('apps', 'desktop', 'src', 'main', 'ipc', 'assets.ts');

    assert.equal((param.match(/knowledgeRefreshOwner: 'caller'/g) ?? []).length, 6);
    assert.equal((event.match(/knowledgeRefreshOwner: 'caller'/g) ?? []).length, 1);
    assert.equal((text.match(/knowledgeRefreshOwner: 'caller'/g) ?? []).length, 1);
    assert.equal((assets.match(/knowledgeRefreshOwner/g) ?? []).length, 0);
    assert.equal((param.match(/runCallerOwnedPostCommit/g) ?? []).length, 7);
    assert.match(event, /runCallerOwnedPostCommit\([\s\S]*POSTCOMMIT_PREVIEW_FAILED/);
  });
});
