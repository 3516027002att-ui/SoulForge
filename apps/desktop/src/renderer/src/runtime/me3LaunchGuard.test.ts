/**
 * me3 启动门槛的单元测试。
 *
 * 覆盖的风险：launchMe3 会**真实启动零售游戏**，而 scope.json 的 SCOPE-RUNTIME
 * 把 `launch-with-missing-or-ambiguous-capability` 列为 unsupportedOperations。
 * 这条判定是那道红线在 renderer 侧的唯一执行点——没有断言就等于没有红线。
 *
 * 断言按**边界**组织而不是只测「一切就绪时可启动」：只测正向的话，把判定改成
 * 恒返回 null（永远允许启动）也会全绿。所以每条前置缺失都单独钉一次，
 * 且「含糊」与「明确否」分开测——前者是最容易被漏掉的一类。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { me3LaunchBlocker } from './me3LaunchGuard.js';

const ready = {
  capability: { state: 'compatible', canLaunch: true },
  profileId: 'profile-1',
  launchConfirmed: true,
  busy: false
};

describe('me3LaunchBlocker', () => {
  it('前置全齐时允许启动（返回 null）', () => {
    assert.equal(me3LaunchBlocker(ready), null);
  });

  it('未探测时禁止——scope 明禁「能力探测缺失时启动」', () => {
    const blocker = me3LaunchBlocker({ ...ready, capability: null });
    assert.notEqual(blocker, null);
    assert.match(String(blocker), /尚未探测/);
  });

  it('探测说不能启动时禁止，且原因带上 state 便于排查', () => {
    const blocker = me3LaunchBlocker({
      ...ready,
      capability: { state: 'incompatible', canLaunch: false }
    });
    assert.notEqual(blocker, null);
    assert.match(String(blocker), /incompatible/);
    assert.match(String(blocker), /canLaunch=false/);
  });

  it('canLaunch 含糊（非 true）时同样禁止——含糊不等于可以', () => {
    // 上游若因字段缺失把 canLaunch 传成 undefined，那是 scope 禁止的
    // ambiguous-capability，不能当成「可以」。判定用 !== true 正是为此。
    for (const ambiguous of [undefined, null, 0, '', 'true']) {
      const blocker = me3LaunchBlocker({
        ...ready,
        capability: {
          state: 'unknown',
          canLaunch: ambiguous as unknown as boolean
        }
      });
      assert.notEqual(
        blocker,
        null,
        `canLaunch=${JSON.stringify(ambiguous)} 是含糊值，必须禁止启动`
      );
    }
  });

  it('未准备 profile 时禁止', () => {
    const blocker = me3LaunchBlocker({ ...ready, profileId: null });
    assert.match(String(blocker), /profile/);
  });

  it('未显式确认时禁止——启动零售游戏必须用户点头', () => {
    const blocker = me3LaunchBlocker({ ...ready, launchConfirmed: false });
    assert.match(String(blocker), /确认/);
  });

  it('有操作进行中时禁止（防重复启动）', () => {
    const blocker = me3LaunchBlocker({ ...ready, busy: true });
    assert.match(String(blocker), /进行/);
  });

  it('判定顺序：未探测优先于其他缺失，避免报一个次要原因', () => {
    // capability 为 null 时读不到 canLaunch，「读不到」本身就是缺失；
    // 若顺序写反，用户会看到「尚未准备 profile」而不知道真正该先做探测。
    const blocker = me3LaunchBlocker({
      capability: null,
      profileId: null,
      launchConfirmed: false,
      busy: true
    });
    assert.match(String(blocker), /尚未探测/);
  });

  it('禁用原因必须是非空字符串，不能只返回 true/false', () => {
    // 只返回布尔会让界面无法回答「差什么」——anti-ai-design 的状态优先原则。
    const blocker = me3LaunchBlocker({ ...ready, capability: null });
    assert.equal(typeof blocker, 'string');
    assert.ok(String(blocker).length > 0);
  });
});
