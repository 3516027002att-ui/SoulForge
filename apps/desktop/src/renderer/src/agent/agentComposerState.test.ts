/**
 * Composer 输入状态机纯逻辑测试（AGENT-60B 三层 Composer）。
 *
 * 覆盖的判定全部来自 AgentPromptEditor.tsx 导出的纯函数，无 DOM、无 IPC：
 * - 输入状态机：等待审批 > 执行中(停止) > 可发送
 * - IME composing 判定：compositionstart/end 状态经 isComposing 守卫，Enter 只换行不发送
 * - grow cap：整个 Composer 不超过 40vh（矮窗口取 min(320, 0.4*vh)）
 * - send/stop 切换：streaming 时发送让位给停止
 * - 空输入发送 disabled
 *
 * 为什么把纯逻辑抽出来：这些行为若只在组件里实现，就只能靠真实 Electron 测，
 * 断言的是渲染结果而不是判定本身。这里把判定做成纯函数，「IME 里 Enter 把消息
 * 发出去了」这类缺陷在单测层就能报红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MAX_HEIGHT_VH,
  clampTextareaHeight,
  composerActionState,
  composerGrowCapPx,
  isComposerSendDisabled,
  shouldConsumeEnterAsSend
} from './AgentPromptEditor.js';

describe('输入状态机：等待审批 > 执行中(停止) > 可发送（§12.6）', () => {
  it('等待审批优先于一切：即使正在跑也不给发送', () => {
    assert.equal(composerActionState({ prompt: '改伤药上限', streaming: true, awaitingApproval: true }), 'awaiting');
    assert.equal(composerActionState({ prompt: '', streaming: false, awaitingApproval: true }), 'awaiting');
  });

  it('执行中发送变为停止', () => {
    assert.equal(composerActionState({ prompt: '继续', streaming: true, awaitingApproval: false }), 'stop');
  });

  it('空闲且有文本时才可发送', () => {
    assert.equal(composerActionState({ prompt: '你好', streaming: false, awaitingApproval: false }), 'send');
  });
});

describe('空输入发送 disabled（§12.6）', () => {
  it('空串与纯空白都算空输入', () => {
    assert.equal(isComposerSendDisabled(''), true);
    assert.equal(isComposerSendDisabled('   \n '), true);
  });

  it('非空文本可发送', () => {
    assert.equal(isComposerSendDisabled('把药葫芦上限调到 8'), false);
  });
});

describe('IME composing 中禁止 Enter 发送', () => {
  it('composing 中 Enter 不消费为发送（只换行）', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'Enter', shiftKey: false, isComposing: true, prompt: '你好', streaming: false }),
      false
    );
  });

  it('composition 结束后 Enter 恢复正常发送', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'Enter', shiftKey: false, isComposing: false, prompt: '你好', streaming: false }),
      true
    );
  });

  it('Shift+Enter 换行，不发送', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'Enter', shiftKey: true, isComposing: false, prompt: '你好', streaming: false }),
      false
    );
  });

  it('composing 与 Shift 同时成立仍不发送', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'Enter', shiftKey: true, isComposing: true, prompt: '你好', streaming: false }),
      false
    );
  });

  it('空文本时 Enter 不发送（与发送按钮 disabled 一致）', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'Enter', shiftKey: false, isComposing: false, prompt: '', streaming: false }),
      false
    );
  });

  it('非 Enter 键永不触发发送', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'a', shiftKey: false, isComposing: false, prompt: '你好', streaming: false }),
      false
    );
  });

  it('streaming 中 Enter 不发送（发送已让位给停止）', () => {
    assert.equal(
      shouldConsumeEnterAsSend({ key: 'Enter', shiftKey: false, isComposing: false, prompt: '继续', streaming: true }),
      false
    );
  });
});

describe('grow cap：整个 Composer 不超过 40vh（§12.6）', () => {
  it('40vh 是规定上限', () => {
    assert.equal(COMPOSER_MAX_HEIGHT_VH, 40);
  });

  it('矮窗口按 0.4*vh 收敛', () => {
    assert.equal(composerGrowCapPx(600), 240);
    assert.equal(composerGrowCapPx(400), 160);
  });

  it('高窗口钉在 320px 像素下限', () => {
    assert.equal(composerGrowCapPx(900), 320);
    assert.equal(composerGrowCapPx(2000), 320);
    assert.equal(COMPOSER_MAX_HEIGHT_PX, 320);
  });

  it('四舍五入取整', () => {
    assert.equal(composerGrowCapPx(651), 260);
  });
});

describe('textarea 高度不超过 cap', () => {
  it('内容低于 cap 时随内容增长', () => {
    assert.equal(clampTextareaHeight(100, 320), 100);
  });

  it('内容超过 cap 时钉在 cap', () => {
    assert.equal(clampTextareaHeight(500, 320), 320);
    assert.equal(clampTextareaHeight(300, 200), 200);
  });

  it('不取负值（cap 或内容为 0 时归零）', () => {
    assert.equal(clampTextareaHeight(0, 320), 0);
    assert.equal(clampTextareaHeight(-10, 320), 0);
    assert.equal(clampTextareaHeight(100, 0), 0);
  });
});
