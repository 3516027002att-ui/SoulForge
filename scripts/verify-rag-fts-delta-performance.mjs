/**
 * 生产 WorkspaceDataRepository 的 RAG/FTS delta 基准。
 *
 * 该脚本只在系统临时目录创建一个隔离 SQLite，调用已构建的 production
 * repository，不复制 mergeRagChunkDelta 的实现。它覆盖 50,000 行的初次
 * 建库、metadata-only、正文变化 full upsert，以及 standalone delete；每个
 * delta 都遵守生产的 512 行上限。
 *
 * 这是有界性能诊断，不是 native、Electron、真实 Mod 语料或发布证明。
 * SF_RAG_FTS_BENCHMARK_TIMEOUT_MS 可缩短/延长总预算（默认 180 秒）。取消
 * 在每个 bounded SQLite batch 之间生效：Ctrl+C、超时或 abort 都会先清理
 * 临时数据库，再返回结构化 cancelled 结果。单个同步 SQLite 调用本身由
 * 512 行批次界定，不能在语句中途被 JS AbortSignal 打断。
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openWorkspaceDatabase } from '../packages/core/dist/storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../packages/core/dist/storage/workspaceDataRepository.js';

const ROWS = 50_000;
const BATCH_SIZE = 512;
const WORKSPACE_ID = 'rag-fts-delta-benchmark';
const SOURCE_URI = 'file://benchmark/gameparam.parambnd.dcx#NpcParam';
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 900_000;

class BenchmarkCancelledError extends Error {
  constructor(reason) {
    super(`RAG FTS benchmark cancelled: ${reason}`);
    this.name = 'BenchmarkCancelledError';
    this.reason = reason;
  }
}

function parseTimeout(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`SF_RAG_FTS_BENCHMARK_TIMEOUT_MS 必须是 ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} 的整数，收到 ${raw}。`);
  }
  return value;
}

function makeChunk(index, variant = 'baseline') {
  const content = variant === 'baseline'
    ? 'ragbenchbaselineold'
    : variant === 'metadata'
      ? 'ragbenchbaselineold'
      : 'ragbenchcontentnew';
  return {
    chunkId: `rag:benchmark:${index}`,
    workspaceId: WORKSPACE_ID,
    sourceUri: SOURCE_URI,
    symbolUri: `param://NpcParam/${index}`,
    family: 'param_row',
    title: `RAG benchmark NpcParam ${index}`,
    body: `rag benchmark row ${index} ${content} npcType ${index % 9}`,
    numericIds: [index],
    contentHash: `${variant}-content-${index}`,
    sourceRevision: variant === 'baseline' ? 1 : variant === 'metadata' ? 2 : 3,
    sourceHash: `${variant}-source-hash`,
    outerFileHash: `${variant}-outer-file-hash`,
    relativePath: 'param/benchmark.parambnd.dcx',
    resourceKind: 'param'
  };
}

function count(database, table, where = '', ...params) {
  // Table names are constants at all call sites; values remain bound.
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...params);
  return Number(row?.count ?? 0);
}

function readPhaseSummary(durations, startedAt, rows, batches) {
  const sorted = [...durations].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    rows,
    batches,
    elapsedMs: round(performance.now() - startedAt),
    batchMs: {
      p50: round(percentile(0.5)),
      p95: round(percentile(0.95)),
      max: round(Math.max(...sorted, 0))
    }
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function assertNotCancelled(signal, deadline, phase, batch) {
  if (signal.aborted) {
    throw new BenchmarkCancelledError(signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'aborted'));
  }
  if (performance.now() >= deadline) {
    throw new BenchmarkCancelledError(`deadline exceeded during ${phase} batch ${batch}`);
  }
}

function runUpsertPhase(repository, signal, deadline, phase, chunks) {
  const startedAt = performance.now();
  const durations = [];
  let batches = 0;
  for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
    assertNotCancelled(signal, deadline, phase, batches + 1);
    const batch = chunks.slice(offset, offset + BATCH_SIZE);
    const started = performance.now();
    repository.mergeRagChunkDelta({ sourceUri: SOURCE_URI, upserts: batch, deletedChunkIds: [] });
    durations.push(performance.now() - started);
    batches += 1;
  }
  assertNotCancelled(signal, deadline, phase, batches);
  return readPhaseSummary(durations, startedAt, chunks.length, batches);
}

function runDeletePhase(repository, signal, deadline, chunkIds) {
  const startedAt = performance.now();
  const durations = [];
  let batches = 0;
  for (let offset = 0; offset < chunkIds.length; offset += BATCH_SIZE) {
    assertNotCancelled(signal, deadline, 'standalone-delete', batches + 1);
    const batch = chunkIds.slice(offset, offset + BATCH_SIZE);
    const started = performance.now();
    repository.mergeRagChunkDelta({ sourceUri: SOURCE_URI, upserts: [], deletedChunkIds: batch });
    durations.push(performance.now() - started);
    batches += 1;
  }
  assertNotCancelled(signal, deadline, 'standalone-delete', batches);
  return readPhaseSummary(durations, startedAt, chunkIds.length, batches);
}

async function main() {
  const timeoutMs = parseTimeout(process.env.SF_RAG_FTS_BENCHMARK_TIMEOUT_MS);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-rag-fts-benchmark-'));
  const databasePath = join(root, 'workspace.db');
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const timeout = setTimeout(() => controller.abort(`timeout after ${timeoutMs}ms`), timeoutMs);
  timeout.unref?.();
  const onInterrupt = () => controller.abort('SIGINT');
  process.once('SIGINT', onInterrupt);
  let database;
  try {
    database = openWorkspaceDatabase(databasePath, { busyTimeoutMs: Math.min(5_000, timeoutMs) });
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(WORKSPACE_ID, root, 'sekiro', now, now);
    const repository = new WorkspaceDataRepository(database, WORKSPACE_ID);
    const baseline = Array.from({ length: ROWS }, (_, index) => makeChunk(index));
    const metadataOnly = baseline.map((chunk) => ({
      ...chunk,
      sourceRevision: 2,
      sourceHash: 'metadata-source-hash',
      outerFileHash: 'metadata-outer-file-hash'
    }));
    const contentChanged = baseline.map((chunk) => ({
      ...chunk,
      body: `${chunk.body} ragbenchcontentnew`,
      contentHash: `content-change-${chunk.chunkId}`,
      sourceRevision: 3,
      sourceHash: 'content-source-hash',
      outerFileHash: 'content-outer-file-hash'
    }));

    const phases = {};
    phases.seed = runUpsertPhase(repository, controller.signal, deadline, 'seed', baseline);
    assert.equal(count(database, 'rag_chunks', ' WHERE workspace_id = ?', WORKSPACE_ID), ROWS, 'seed main-row count');
    assert.equal(count(database, 'rag_chunks_fts'), ROWS, 'seed unicode FTS row count');
    assert.equal(count(database, 'rag_chunks_fts_trigram'), ROWS, 'seed trigram FTS row count');

    phases.metadataOnly = runUpsertPhase(repository, controller.signal, deadline, 'metadata-only', metadataOnly);
    assert.equal(count(database, 'rag_chunks', ' WHERE workspace_id = ?', WORKSPACE_ID), ROWS, 'metadata main-row count');
    assert.equal(count(database, 'rag_chunks_fts'), ROWS, 'metadata unicode FTS row count');
    assert.equal(count(database, 'rag_chunks_fts_trigram'), ROWS, 'metadata trigram FTS row count');
    const metadataRow = database.prepare(
      'SELECT source_revision AS sourceRevision, source_hash AS sourceHash, outer_file_hash AS outerFileHash FROM rag_chunks WHERE chunk_id = ?'
    ).get(baseline[0].chunkId);
    assert.equal(Number(metadataRow?.sourceRevision), 2, 'metadata source revision');
    assert.equal(metadataRow?.sourceHash, 'metadata-source-hash', 'metadata source hash');

    phases.contentChangeFullUpsert = runUpsertPhase(repository, controller.signal, deadline, 'content-change-full-upsert', contentChanged);
    assert.equal(count(database, 'rag_chunks', ' WHERE workspace_id = ?', WORKSPACE_ID), ROWS, 'content-change main-row count');
    assert.equal(count(database, 'rag_chunks_fts'), ROWS, 'content-change unicode FTS row count');
    assert.equal(count(database, 'rag_chunks_fts_trigram'), ROWS, 'content-change trigram FTS row count');
    const changedBody = database.prepare('SELECT body FROM rag_chunks WHERE chunk_id = ?').get(baseline[0].chunkId);
    assert.match(String(changedBody?.body ?? ''), /ragbenchcontentnew/, 'content-change body');

    phases.standaloneDelete = runDeletePhase(repository, controller.signal, deadline, baseline.map((chunk) => chunk.chunkId));
    assert.equal(count(database, 'rag_chunks', ' WHERE workspace_id = ?', WORKSPACE_ID), 0, 'delete main-row count');
    assert.equal(count(database, 'rag_chunks_fts'), 0, 'delete unicode FTS row count');
    assert.equal(count(database, 'rag_chunks_fts_trigram'), 0, 'delete trigram FTS row count');

    const result = {
      ok: true,
      status: 'passed',
      contract: 'production-rag-fts-delta-performance',
      scope: 'synthetic-isolated-sqlite-only',
      implementation: 'packages/core/dist/storage/workspaceDataRepository.js',
      rows: ROWS,
      batchSize: BATCH_SIZE,
      timeoutMs,
      phases,
      finalCounts: { ragChunks: 0, unicodeFts: 0, trigramFts: 0 },
      nonClaims: [
        '不证明真实 Mod 语料、native parser、Electron IPC、发布构建或生产 Agent 数据库。',
        '不把 FTS rowid 与主表 rowid 视为同步；验证只使用 chunk_id、主表计数和两张 FTS 表计数。',
        '本 benchmark 不改变 schema；优化建议需保持 FTS contentful/UNINDEXED 布局、现有事务边界与 source guard。'
      ]
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', onInterrupt);
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (error instanceof BenchmarkCancelledError) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'cancelled',
      contract: 'production-rag-fts-delta-performance',
      reason: error.reason,
      rows: ROWS,
      batchSize: BATCH_SIZE
    })}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
