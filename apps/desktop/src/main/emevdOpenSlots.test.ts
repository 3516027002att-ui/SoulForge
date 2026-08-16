/**
 * EmevdOpenSlots 的不变式测试。
 *
 * 每个用例只钉一条不变式，且都对应一个**实际报告过的缺陷形态**，不是为覆盖率
 * 凑的用例：
 *   - 同窗口后到者顶掉先到者（原行为正确，防回归）
 *   - 跨窗口互不取消（原全局槽的缺陷：B 窗口打开会打断 A 窗口）
 *   - 建槽顺序由调用顺序决定，与后续 await 时长无关（原缺陷：建槽排在
 *     await prepareBridgeRoots 之后，慢的旧请求会反过来取消快的新请求）
 *   - dispose 回收（原缺陷：窗口销毁后槽位按 id 无界留存）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EmevdOpenSlots } from './emevdOpenSlots.js';

test('同一窗口：后到的打开请求中止先到的那份', () => {
  const slots = new EmevdOpenSlots();
  const first = slots.begin(1, 'file://event/a.emevd');
  const second = slots.begin(1, 'file://event/b.emevd');
  assert.equal(first.signal.aborted, true, '同窗口的旧请求必须被中止');
  assert.equal(second.signal.aborted, false, '新请求不能一建出来就是中止态');
});

test('跨窗口：一个窗口的打开不影响另一个窗口在飞的那份', () => {
  const slots = new EmevdOpenSlots();
  const windowA = slots.begin(1, 'file://event/a.emevd');
  const windowB = slots.begin(2, 'file://event/b.emevd');
  // 这条是全局单槽版本的真实缺陷：B 窗口打开任何事件文档都会把 A 打断。
  assert.equal(windowA.signal.aborted, false, '另一个窗口的打开不得取消本窗口的读');
  assert.equal(windowB.signal.aborted, false, '新窗口的请求不该被中止');
  slots.begin(2, 'file://event/c.emevd');
  assert.equal(windowA.signal.aborted, false, '窗口 2 内部的替换仍不得波及窗口 1');
});

test('建槽顺序只由调用顺序决定，与各自后续的 await 时长无关', async () => {
  const slots = new EmevdOpenSlots();
  // 模拟两条 handler：旧请求先到但准备阶段慢，新请求后到但准备阶段快。
  // 建槽在第一个 await 之前，所以「谁先到谁先建槽」必须恒成立。
  const older = { controller: null as AbortController | null };
  const newer = { controller: null as AbortController | null };
  const handler = async (
    slot: { controller: AbortController | null },
    prepareMs: number
  ): Promise<void> => {
    slot.controller = slots.begin(7, `file://event/${prepareMs}.emevd`);
    await new Promise((resolve) => setTimeout(resolve, prepareMs));
  };
  const olderCall = handler(older, 30);
  const newerCall = handler(newer, 0);
  await Promise.all([olderCall, newerCall]);
  assert.equal(older.controller?.signal.aborted, true, '先到的旧请求必须被后到的新请求顶掉');
  assert.equal(
    newer.controller?.signal.aborted,
    false,
    '慢的旧请求不得反过来取消快的新请求 —— 这正是建槽排在 await 之后时的缺陷'
  );
});

test('cancel 区分「取消掉了」与「无事可取消」', () => {
  const slots = new EmevdOpenSlots();
  assert.equal(slots.cancel(1), false, '没有在飞的读时必须报 false，不能假称取消了');
  const controller = slots.begin(1, 'file://event/a.emevd');
  assert.equal(slots.cancel(1), true, '有在飞的读时必须真的中止并报 true');
  assert.equal(controller.signal.aborted, true, 'cancel 必须真的打在 controller 上');
  assert.equal(slots.cancel(1), false, '同一份不得被报告为取消两次');
});

test('finish 按身份归还后 cancel 不得再报成功', () => {
  const slots = new EmevdOpenSlots();
  const controller = slots.begin(1, 'file://event/a.emevd');
  assert.equal(slots.finish(1, 'file://event/a.emevd', controller), true);
  assert.equal(slots.size, 0);
  assert.equal(slots.cancel(1), false, '已完成的请求不得再被报告为取消成功');
  assert.equal(controller.signal.aborted, false, 'finish 不得 abort 已成功的 controller');
});

test('finish 身份不符时不得清掉后到的槽', () => {
  const slots = new EmevdOpenSlots();
  const first = slots.begin(1, 'file://event/a.emevd');
  slots.begin(1, 'file://event/b.emevd');
  assert.equal(slots.finish(1, 'file://event/a.emevd', first), false);
  assert.equal(slots.size, 1);
});

test('dispose 中止在飞的读并回收槽位', () => {
  const slots = new EmevdOpenSlots();
  const controller = slots.begin(1, 'file://event/a.emevd');
  slots.begin(2, 'file://event/b.emevd');
  assert.equal(slots.size, 2);
  slots.dispose(1);
  assert.equal(controller.signal.aborted, true, '窗口销毁时在飞的读必须被中止');
  assert.equal(slots.size, 1, 'dispose 必须真的删掉槽位，否则按窗口 id 无界增长');
  slots.dispose(1);
  assert.equal(slots.size, 1, 'dispose 幂等：重复调用不得抛错也不得影响别的窗口');
});
