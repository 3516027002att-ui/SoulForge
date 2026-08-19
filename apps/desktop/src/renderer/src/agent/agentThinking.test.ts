/**
 * 2-A：思考强度按协议换官方表的纯逻辑单元测试。
 *
 * 锁定三件事：
 * 1. OpenAI 表 = 官方全档 off/none/minimal/low/medium/high/xhigh/max；
 * 2. Anthropic 表 = off/low/medium/high/xhigh/max（官方没有 none/minimal，
 *    也没有 budget_tokens 数字）；标签是英文官方值，不得翻译；
 * 3. 换协议时不在表里的档收敛到两表都合法的默认档 'medium'（max 等官方档
 *    不被折成 high，也绝不让 deep/extreme 这种旧档回来）。
 *
 * 适配器怎么发字段由 runModelServiceSamplingSmoke 锁（reasoning_effort /
 * reasoning.effort / output_config.effort，off → 字段缺席）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  thinkingLevelsForProtocol,
  thinkingLevelLabel,
  convergeThinkingLevel
} from './agentThinking.js';

const OPENAI_TABLE = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ANTHROPIC_TABLE = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('thinkingLevelsForProtocol（2-A 官方档位表）', () => {
  it('OpenAI 协议 = 官方全档（含 none/minimal/xhigh/max，不得丢 max）', () => {
    const levels = thinkingLevelsForProtocol('openai-compatible');
    assert.deepEqual(levels, OPENAI_TABLE);
  });

  it('Anthropic 协议 = off/low/medium/high/xhigh/max（官方没有 none/minimal）', () => {
    const levels = thinkingLevelsForProtocol('anthropic-compatible');
    assert.deepEqual(levels, ANTHROPIC_TABLE);
  });

  it('两表都不含旧档 fast/normal/deep/extreme，也不含 budget 数字', () => {
    for (const protocol of ['openai-compatible', 'anthropic-compatible'] as const) {
      const levels = thinkingLevelsForProtocol(protocol) as readonly string[];
      for (const legacy of ['fast', 'normal', 'deep', 'extreme', '2048', '4096', '8192', '16384']) {
        assert.ok(!levels.includes(legacy), `${protocol} 表不得含 ${legacy}`);
      }
    }
  });
});

describe('thinkingLevelLabel（2-A 英文官方值标签）', () => {
  it('OpenAI：Off / none / minimal / low / medium / high / xhigh / max', () => {
    const pairs: Array<[import('@soulforge/core').ModelThinkingLevel, string]> = [
      ['off', 'Off'],
      ['none', 'none'],
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'xhigh'],
      ['max', 'max']
    ];
    for (const [level, expected] of pairs) {
      assert.equal(thinkingLevelLabel(level, 'openai-compatible'), expected, `${level} label`);
    }
  });

  it('Anthropic：Off / low / medium / high / xhigh / max', () => {
    const pairs: Array<[import('@soulforge/core').ModelThinkingLevel, string]> = [
      ['off', 'Off'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'xhigh'],
      ['max', 'max']
    ];
    for (const [level, expected] of pairs) {
      assert.equal(thinkingLevelLabel(level, 'anthropic-compatible'), expected, `${level} label`);
    }
  });
});

describe('convergeThinkingLevel（2-A 换协议收敛到两表合法默认）', () => {
  it('Anthropic 表没有的档（none/minimal）收敛到 medium', () => {
    assert.equal(convergeThinkingLevel('none', 'anthropic-compatible'), 'medium');
    assert.equal(convergeThinkingLevel('minimal', 'anthropic-compatible'), 'medium');
  });

  it('两表都合法的官方档原样保留（max 不被折成 high）', () => {
    assert.equal(convergeThinkingLevel('max', 'openai-compatible'), 'max');
    assert.equal(convergeThinkingLevel('max', 'anthropic-compatible'), 'max');
    assert.equal(convergeThinkingLevel('high', 'openai-compatible'), 'high');
    assert.equal(convergeThinkingLevel('medium', 'anthropic-compatible'), 'medium');
  });

  it('OpenAI 全档都在表里，不触发收敛', () => {
    const levels = thinkingLevelsForProtocol('openai-compatible');
    for (const level of levels) {
      assert.equal(convergeThinkingLevel(level, 'openai-compatible'), level);
    }
  });
});
