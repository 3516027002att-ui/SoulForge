import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalCliSession } from '../cli/localCliSession.js';

const root = await mkdtemp(join(tmpdir(), 'soulforge-cli-semantic-bootstrap-'));
try {
  await mkdir(join(root, 'param'), { recursive: true });
  await writeFile(
    join(root, 'param', 'mockparam.json'),
    JSON.stringify({
      paramName: 'NpcParam',
      rows: [{ rowId: 50800000, rowName: '鬼刑部', fields: [{ id: 'hp', value: 1000 }] }]
    }),
    'utf8'
  );

  const first = await openLocalCliSession({
    overlayRoot: root,
    mode: 'plan',
    principal: 'cli-semantic-bootstrap-smoke'
  });
  try {
    assert.equal(first.workspaceIndex.getStats().paramRows, 1,
      '普通 CLI 工具会话必须先建立 PARAM 语义索引，不能只有目录扫描');
    const stats = await first.bridge.executeTool({
      id: 'cli-semantic-bootstrap-stats',
      name: 'workspace_stats',
      argumentsJson: '{}'
    });
    assert.equal(stats.ok, true);
    const statsEnvelope = JSON.parse(String(stats.content)) as {
      data?: {
        record?: {
          paramRows?: number;
          semanticIndex?: { readiness?: string; rag?: { byFamily?: { param_row?: number } } };
        }
      };
    };
    assert.equal(statsEnvelope.data?.record?.paramRows, 1);
    assert.notEqual(statsEnvelope.data?.record?.semanticIndex?.readiness, 'catalog-ready');
    assert.equal(statsEnvelope.data?.record?.semanticIndex?.rag?.byFamily?.param_row, 1,
      'RAG fallback 不能丢掉已经解析的 PARAM 行');
    assert.equal(JSON.parse(String(stats.content)).completeness, 'partial',
      '覆盖不完整时模型 envelope 不能伪装成 complete');
  } finally {
    await first.dispose();
  }

  const reopened = await openLocalCliSession({
    overlayRoot: root,
    mode: 'plan',
    principal: 'cli-semantic-bootstrap-smoke-reopen'
  });
  try {
    assert.equal(reopened.workspaceIndex.getStats().paramRows, 1,
      '第二次 CLI 会话必须复用或重建可验证的语义缓存');
  } finally {
    await reopened.dispose();
  }

  console.log(JSON.stringify({
    ok: true,
    suite: 'cli-semantic-bootstrap',
    checks: ['default-semantic-bootstrap', 'workspace-stats-readiness', 'reopen-cache']
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
