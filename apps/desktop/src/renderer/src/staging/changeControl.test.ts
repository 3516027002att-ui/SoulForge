/**
 * 变更控制状态机的单元测试（node:test，无新增依赖、无 DOM）。
 *
 * 为什么这是前端改造的前置条件：
 * changeControl 是四条写路径（文本 / FMG / PARAM 行 / PARAM 字段）的共同闸门，
 * 而 renderer 此前**零单元测试**，唯一的 e2e 又跑在 mock main 上（19/56 通道），
 * 覆盖不到大部分面板。这意味着拆 App.tsx 时没有安全网：状态复位漏一处不会有
 * 编译错误、不会有测试失败，症状是切换工作区后残留上一工作区的数据——而项目
 * 硬约束 7 要求严格区分 native-verified 与其他状态，脏残留恰好会伪造「已解析」
 * 观感。所以先建断言，再动结构。
 *
 * 选 node:test 而不是引入 vitest：changeControl 是纯逻辑无 DOM 依赖，Node 内置
 * 测试器足够，符合「非必要不引入新依赖」。将来确需组件测试再单独提案。
 *
 * 覆盖原则：正向路径与**非法转移**都要断言。只测正向的话，把 TRANSITIONS 改成
 * 「什么都允许」仍会全绿——那种测试守不住状态机。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ChangeControlStore,
  validateChange,
  type CandidateChange,
  type ChangeKind,
  type ChangeStatus,
  type ProposeInput
} from './changeControl.js';

/** 造一条最小合法候选。payload 按 kind 给足，避免 validate 因缺字段而失败。 */
function proposeInput(overrides: Partial<ProposeInput> = {}): ProposeInput {
  const kind: ChangeKind = overrides.kind ?? 'text';
  const defaultPayload: Record<ChangeKind, Record<string, unknown>> = {
    text: { newText: 'after' },
    fmg: { id: 1, op: 'upsert', text: 'after' },
    'param-row': { op: 'upsert', dataBase64: 'AAAA' },
    'param-field': { fieldId: 'hp', value: '100', definition: { displayType: 's32' } }
  };
  return {
    kind,
    sourceUri: 'file:///workspace/a.fmg',
    target: 'a.fmg#1',
    summary: 'text: before → after',
    oldValue: 'before',
    newValue: 'after',
    payload: defaultPayload[kind],
    ...overrides
  };
}

function statusOf(store: ChangeControlStore, id: string): ChangeStatus | undefined {
  return store.getState().items.find((item) => item.id === id)?.status;
}

describe('ChangeControlStore 转移表', () => {
  it('propose 产出 draft 且进入队列', () => {
    const store = new ChangeControlStore();
    const change = store.propose(proposeInput());
    assert.equal(change.status, 'draft');
    assert.equal(store.getState().items.length, 1);
    assert.equal(store.pendingDrafts(), 1);
    assert.equal(store.stagedCount(), 0);
  });

  it('同源同目标的再次 propose 替换旧候选而不是堆积', () => {
    const store = new ChangeControlStore();
    store.propose(proposeInput({ newValue: 'first' }));
    store.propose(proposeInput({ newValue: 'second' }));
    const { items } = store.getState();
    assert.equal(items.length, 1, '同一 id 只应保留最新一条');
    assert.equal(items[0]!.newValue, 'second');
  });

  it('draft → staged → validating → writing → written 全链路合法', () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    assert.equal(store.approve(id), true);
    assert.equal(statusOf(store, id), 'staged');
    assert.equal(store.stagedCount(), 1);
  });

  it('written 是终态：不得再被批准、拒绝或撤回', async () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);
    await store.commitAll(async () => ({ ok: true }));
    assert.equal(statusOf(store, id), 'written');
    assert.equal(store.approve(id), false, 'written 不得回到 staged');
    assert.equal(store.reject(id), false, 'written 不得被拒绝');
    assert.equal(store.undoToDraft(id), false, 'written 不得撤回到候选');
    assert.equal(statusOf(store, id), 'written', '非法转移不得改动状态');
  });

  it('staged 可撤回到候选（撤销语义）', () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);
    assert.equal(store.undoToDraft(id), true);
    assert.equal(statusOf(store, id), 'draft');
  });

  it('draft 不可直接撤回到 draft（自环非法）', () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    assert.equal(store.undoToDraft(id), false);
    assert.equal(statusOf(store, id), 'draft');
  });

  it('failed 可重新批准（失败重批）', async () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);
    await store.commitAll(async () => ({
      ok: false,
      diagnostics: [{ code: 'ORIGINAL_CHANGED_DURING_STAGING', message: '原文件已变化。' }]
    }));
    assert.equal(statusOf(store, id), 'failed');
    assert.equal(store.approve(id), true, 'failed 必须能重新批准');
    assert.equal(statusOf(store, id), 'staged');
  });

  it('rejected 可恢复为 staged 或 draft，但不得直接进入 validating', () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    assert.equal(store.reject(id), true);
    assert.equal(statusOf(store, id), 'rejected');
    assert.equal(store.approve(id), true);
    assert.equal(statusOf(store, id), 'staged');
  });

  it('不存在的 id 上所有转移都返回 false 且不抛异常', () => {
    const store = new ChangeControlStore();
    assert.equal(store.approve('nope'), false);
    assert.equal(store.reject('nope'), false);
    assert.equal(store.undoToDraft('nope'), false);
  });

  it('discard 移除单条；clearTerminal 只清 written/rejected', async () => {
    const store = new ChangeControlStore();
    const written = store.propose(proposeInput({ target: 'a#1' }));
    const rejected = store.propose(proposeInput({ target: 'a#2' }));
    const kept = store.propose(proposeInput({ target: 'a#3' }));
    store.approve(written.id);
    await store.commitAll(async () => ({ ok: true }));
    store.reject(rejected.id);

    store.clearTerminal();
    const ids = store.getState().items.map((item) => item.id);
    assert.deepEqual(ids, [kept.id], 'written 与 rejected 应被清除，draft 保留');

    store.discard(kept.id);
    assert.equal(store.getState().items.length, 0);
  });
});

describe('ChangeControlStore.commitAll', () => {
  it('只提交 staged，跳过 draft', async () => {
    const store = new ChangeControlStore();
    const staged = store.propose(proposeInput({ target: 'a#1' }));
    const draft = store.propose(proposeInput({ target: 'a#2' }));
    store.approve(staged.id);

    const applied: string[] = [];
    const result = await store.commitAll(async (change) => {
      applied.push(change.id);
      return { ok: true };
    });

    assert.deepEqual(applied, [staged.id], 'draft 不得被写入');
    assert.deepEqual(result, { written: 1, failed: 0 });
    assert.equal(statusOf(store, draft.id), 'draft');
  });

  it('校验失败的项落 failed 并带诊断，不调用 applier', async () => {
    const store = new ChangeControlStore();
    // 空文本会被 validateChange 判 TEXT_EMPTY。
    const { id } = store.propose(proposeInput({ newValue: '', payload: { newText: '' } }));
    store.approve(id);

    let applierCalled = false;
    const result = await store.commitAll(async () => {
      applierCalled = true;
      return { ok: true };
    });

    assert.equal(applierCalled, false, '校验未过不得进入写入');
    assert.deepEqual(result, { written: 0, failed: 1 });
    const item = store.getState().items.find((candidate) => candidate.id === id)!;
    assert.equal(item.status, 'failed');
    assert.equal(item.diagnostics[0]?.code, 'TEXT_EMPTY');
  });

  it('applier 抛异常时落 failed 并保留异常信息，不吞掉', async () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);

    const result = await store.commitAll(async () => {
      throw new Error('bridge daemon exited');
    });

    assert.deepEqual(result, { written: 0, failed: 1 });
    const item = store.getState().items.find((candidate) => candidate.id === id)!;
    assert.equal(item.status, 'failed');
    assert.equal(item.diagnostics[0]?.code, 'APPLY_EXCEPTION');
    assert.match(item.diagnostics[0]!.message, /bridge daemon exited/);
  });

  it('applier 返回 ok:false 但无诊断时补默认诊断（不得静默失败）', async () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);
    await store.commitAll(async () => ({ ok: false }));
    const item = store.getState().items.find((candidate) => candidate.id === id)!;
    assert.equal(item.status, 'failed');
    assert.equal(item.diagnostics[0]?.code, 'APPLY_FAILED');
  });

  it('一条失败不阻断其余项（顺序执行、逐项落状态）', async () => {
    const store = new ChangeControlStore();
    const first = store.propose(proposeInput({ target: 'a#1' }));
    const second = store.propose(proposeInput({ target: 'a#2' }));
    store.approve(first.id);
    store.approve(second.id);

    const result = await store.commitAll(async (change) => ({ ok: change.id === second.id }));
    assert.deepEqual(result, { written: 1, failed: 1 });
    assert.equal(statusOf(store, first.id), 'failed');
    assert.equal(statusOf(store, second.id), 'written');
  });

  it('committing 期间重入直接返回，不重复写入', async () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);

    let calls = 0;
    let reentrant: { written: number; failed: number } | null = null;
    const outer = store.commitAll(async () => {
      calls += 1;
      // 在写入进行中重入：必须被 committing 标志挡住。
      reentrant = await store.commitAll(async () => {
        calls += 1;
        return { ok: true };
      });
      return { ok: true };
    });
    await outer;

    assert.equal(calls, 1, 'applier 只应被调用一次');
    assert.deepEqual(reentrant, { written: 0, failed: 0 }, '重入应立即返回空结果');
  });

  it('提交结束后 committing 复位（否则后续提交会被永久挡住）', async () => {
    const store = new ChangeControlStore();
    const { id } = store.propose(proposeInput());
    store.approve(id);
    await store.commitAll(async () => {
      throw new Error('boom');
    });
    assert.equal(store.getState().committing, false);
  });

  it('subscribe 在状态变化时被通知，取消订阅后不再通知', () => {
    const store = new ChangeControlStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.propose(proposeInput());
    assert.ok(notifications > 0, '状态变化必须通知订阅者');
    const seen = notifications;
    unsubscribe();
    store.propose(proposeInput({ target: 'a#9' }));
    assert.equal(notifications, seen, '取消订阅后不得再通知');
  });
});

describe('validateChange', () => {
  const base: CandidateChange = {
    id: 'x',
    kind: 'text',
    sourceUri: 'file:///a',
    target: 'a',
    summary: '',
    oldValue: '',
    newValue: 'after',
    status: 'staged',
    diagnostics: [],
    payload: {},
    createdAt: 0,
    updatedAt: 0
  };

  it('text：空内容被拒', () => {
    assert.equal(validateChange({ ...base, newValue: '' })[0]?.code, 'TEXT_EMPTY');
    assert.deepEqual(validateChange({ ...base, newValue: 'ok' }), []);
  });

  it('fmg：ID 必须是非负整数', () => {
    const fmg = { ...base, kind: 'fmg' as ChangeKind };
    for (const bad of [-1, 1.5, Number.NaN, '3' as unknown as number, undefined]) {
      const codes = validateChange({ ...fmg, payload: { id: bad, op: 'upsert', text: 't' } })
        .map((problem) => problem.code);
      assert.ok(codes.includes('FMG_ID_INVALID'), `id=${String(bad)} 应被拒`);
    }
    assert.deepEqual(validateChange({ ...fmg, payload: { id: 0, op: 'upsert', text: 't' } }), []);
  });

  it('fmg：upsert/add 缺文本被拒，delete 不要求文本', () => {
    const fmg = { ...base, kind: 'fmg' as ChangeKind };
    for (const op of ['upsert', 'add']) {
      const codes = validateChange({ ...fmg, payload: { id: 1, op } }).map((p) => p.code);
      assert.ok(codes.includes('FMG_TEXT_MISSING'), `op=${op} 缺文本应被拒`);
    }
    assert.deepEqual(validateChange({ ...fmg, payload: { id: 1, op: 'delete' } }), []);
  });

  it('param-row：upsert 缺字节载荷被拒', () => {
    const row = { ...base, kind: 'param-row' as ChangeKind };
    assert.equal(
      validateChange({ ...row, payload: { op: 'upsert' } })[0]?.code,
      'PARAM_ROW_PAYLOAD_MISSING'
    );
    assert.deepEqual(validateChange({ ...row, payload: { op: 'upsert', dataBase64: 'AA' } }), []);
  });

  it('param-field：空值被拒', () => {
    const field = { ...base, kind: 'param-field' as ChangeKind };
    for (const value of [undefined, '']) {
      const codes = validateChange({ ...field, payload: { fieldId: 'hp', value } })
        .map((problem) => problem.code);
      assert.ok(codes.includes('PARAM_FIELD_EMPTY'), `value=${String(value)} 应被拒`);
    }
  });

  it('param-field：数值类型字段拒非数字（按 definition 判定）', () => {
    const field = { ...base, kind: 'param-field' as ChangeKind };
    const numericTypes = ['s32', 'u8', 'f32', 'int', 'float', 'byte', 'short', 'long'];
    for (const displayType of numericTypes) {
      const codes = validateChange({
        ...field,
        payload: { fieldId: 'hp', value: 'not-a-number', definition: { displayType } }
      }).map((problem) => problem.code);
      assert.ok(codes.includes('PARAM_FIELD_NOT_NUMERIC'), `${displayType} 应要求数值`);
    }
    // 数值类型 + 合法数字：放行。
    assert.deepEqual(
      validateChange({
        ...field,
        payload: { fieldId: 'hp', value: '100', definition: { displayType: 's32' } }
      }),
      []
    );
    // 非数值类型（字符串字段）：不做数值校验。
    assert.deepEqual(
      validateChange({
        ...field,
        payload: { fieldId: 'name', value: 'Sekiro', definition: { displayType: 'fixstr' } }
      }),
      []
    );
  });
});
