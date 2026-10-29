import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  STORAGE_PROBE_PREFIX,
  probeFileName,
  sweepStaleStorageProbes,
  verifyDirectoryWritable
} from './workspaceStorageProbe.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'sf-storage-probe-'));
}

function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

describe('workspace storage probe', () => {
  it('写入并删除探针，目录里不留东西', () => {
    const directory = workspace();
    try {
      verifyDirectoryWritable(directory);
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      cleanup(directory);
    }
  });

  it('目录不可写时抛错，而不是假装成功', () => {
    assert.throws(() => verifyDirectoryWritable(join(workspace(), 'missing-subdir')));
  });

  it('只清过期探针，刚写下的（可能是并发实例）保留', () => {
    const directory = workspace();
    const now = 1_800_000_000_000;
    const stale = join(directory, probeFileName(1, now));
    const fresh = join(directory, probeFileName(2, now));
    const other = join(directory, 'workspace.db');
    try {
      writeFileSync(stale, 'ok', 'utf8');
      writeFileSync(fresh, 'ok', 'utf8');
      writeFileSync(other, 'db', 'utf8');
      utimesSync(stale, new Date(now - 120_000), new Date(now - 120_000));
      utimesSync(fresh, new Date(now), new Date(now));

      assert.equal(sweepStaleStorageProbes(directory, { now }), 1);
      assert.equal(existsSync(stale), false, '过期探针必须清掉');
      assert.equal(existsSync(fresh), true, '新探针属于并发实例，不能删');
      assert.equal(existsSync(other), true, '非探针文件一律不碰');
    } finally {
      cleanup(directory);
    }
  });

  it('只认自己的前缀，目录不存在时静默返回 0', () => {
    const directory = workspace();
    try {
      writeFileSync(join(directory, `${STORAGE_PROBE_PREFIX}x`), 'ok', 'utf8');
      assert.equal(sweepStaleStorageProbes(join(directory, 'nope')), 0);
      assert.equal(sweepStaleStorageProbes(directory, { now: Date.now() + 10 * 60_000 }), 1);
    } finally {
      cleanup(directory);
    }
  });
});
