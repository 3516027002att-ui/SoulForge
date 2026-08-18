/**
 * 8-B/8-C：思考强度按协议换表的纯逻辑单元测试。
 *
 * 锁定三件事：
 * 1. OpenAI 协议的表不得含 extreme（deep/extreme 都会发成 high，给两档是假档）；
 * 2. OpenAI 标签是 Off/Low/Medium/High（英文），Anthropic 标签是 Off/2048/4096/8192/16384；
 * 3. 换协议时非法档收敛到 'deep'（两表都合法）。
 *
 * 不改 resolveOpenAiReasoningEffort / resolveAnthropicThinkingBudget（map 来源测试
 * 是 runModelServiceSamplingSmoke），这里只管 UI 表。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  thinkingLevelsForProtocol,
  thinkingLevelLabel,
  convergeThinkingLevel
} from './agentThinking.js';

describe('thinkingLevelsForProtocol（8-B 按协议换表）', () => {
  it('OpenAI 协议只有 off/fast/normal/deep，绝不包含 extreme（两个都会发成 high）', () => {
    const levels = thinkingLevelsForProtocol('openai-compatible');
    assert.deepEqual(levels, ['off', 'fast', 'normal', 'deep']);
    assert.ok(!levels.includes('extreme'), 'openai 表不得含 extreme');
  });

  it('Anthropic 协议四档 budget 全给（off/fast/normal/deep/extreme）', () => {
    const levels = thinkingLevelsForProtocol('anthropic-compatible');
    assert.deepEqual(levels, ['off', 'fast', 'normal', 'deep', 'extreme']);
  });
});

describe('thinkingLevelLabel（8-B 英文标签）', () => {
  it('OpenAI：Off / Low / Medium / High', () => {
    assert.equal(thinkingLevelLabel('off', 'openai-compatible'), 'Off');
    assert.equal(thinkingLevelLabel('fast', 'openai-compatible'), 'Low');
    assert.equal(thinkingLevelLabel('normal', 'openai-compatible'), 'Medium');
    assert.equal(thinkingLevelLabel('deep', 'openai-compatible'), 'High');
    // deep/extreme 在 OpenAI 下都发 high，标签一致。
    assert.equal(thinkingLevelLabel('extreme', 'openai-compatible'), 'High');
  });

  it('Anthropic：Off / 2048 / 4096 / 8192 / 16384（budget_tokens）', () => {
    assert.equal(thinkingLevelLabel('off', 'anthropic-compatible'), 'Off');
    assert.equal(thinkingLevelLabel('fast', 'anthropic-compatible'), '2048');
    assert.equal(thinkingLevelLabel('normal', 'anthropic-compatible'), '4096');
    assert.equal(thinkingLevelLabel('deep', 'anthropic-compatible'), '8192');
    assert.equal(thinkingLevelLabel('extreme', 'anthropic-compatible'), '16384');
  });
});

describe('convergeThinkingLevel（8-C 换协议收敛非法档）', () => {
  it('OpenAI + extreme 收敛到 deep（High）', () => {
    assert.equal(convergeThinkingLevel('extreme', 'openai-compatible'), 'deep');
  });

  it('两表都合法的档原样保留', () => {
    assert.equal(convergeThinkingLevel('normal', 'openai-compatible'), 'normal');
    assert.equal(convergeThinkingLevel('extreme', 'anthropic-compatible'), 'extreme');
  });
});
