/**
 * ModelServiceSettingsPanel 的 2-A / 2-E 源码级契约测试。
 *
 * 为什么是源码断言而不是行为断言：renderer 单测入口（run-renderer-unit-tests.mjs）
 * 只收无 DOM 的纯逻辑测试，react-dom 交互（填 input → 等 debounce → 断言 bridge
 * 被调用）要真实 DOM，属于 test:renderer-e2e。这里锁的是「保存逻辑的契约」——
 * 负向扰动（把 debounce 的 save() 调用注释掉）必须能让这些断言变红。
 *
 * 锁定的契约（2-E）：
 * 1. 每个会写入服务配置的字段（protocol/baseUrl/model/displayName/apiKey/数字/effort）
 *    的 onChange 都调用 scheduleAutoSave()（debounce，不每按键打 IPC）；
 * 2. flushAutoSave 在 baseUrl 为空时直接返回（不 upsert 空服务）；
 * 3. 载荷用 `...(apiKey ? { apiKey } : {})` —— apiKey 为空不带该字段，绝不把
 *    '' 覆盖到已加密凭据上；
 * 4. 校验失败（temperature 越界等）返回 null，调用方 `if (payload === null) return;`
 *    不写盘；
 * 5. 自动保存成功文案是一行「已自动保存：<displayName>」（走 setStatus，不模态、
 *    不 toast）；
 * 6. 卸载（关抽屉/切走）前 cleanup 会 flush 一次未写完的 debounce；
 * 7. 2-A：effort 下拉用官方表，英文说明不再写 budget_tokens 数字。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'ModelServiceSettingsPanel.tsx'),
  'utf8'
);

describe('2-E 自动保存契约（源码级）', () => {
  it('所有会写入配置的字段 onChange 都触发 debounce 自动保存', () => {
    // 每个 saveable 字段的 onChange 里必须有 scheduleAutoSave()。窗口放宽到 300
    // 字符：protocol 的 onChange 在 setProtocol 到 scheduleAutoSave 之间还夹着
    // convergeThinkingLevel（换协议收敛非法档）的调用。
    for (const field of ['setProtocol', 'setBaseUrl', 'setModel', 'setDisplayName', 'setApiKey']) {
      assert.match(source, new RegExp(`${field}\\([^)]*\\);[\\s\\S]{0,300}scheduleAutoSave\\(\\)`),
        `${field} 的 onChange 应调用 scheduleAutoSave()`);
    }
    // 数字 / effort 字段走同一份 debounce 入口。
    for (const field of [
      'setThinkingLevel', 'setContextWindowTokens', 'setMaxTokens',
      'setTemperature', 'setTopP', 'setTopK', 'setEmbeddingModel'
    ]) {
      assert.match(source, new RegExp(`${field}\\([^)]*\\);[\\s\\S]{0,300}scheduleAutoSave\\(\\)`),
        `${field} 的 onChange 应调用 scheduleAutoSave()`);
    }
  });

  it('debounce 定时器到期必须实际调用 flushAutoSave()（注释掉就红）', () => {
    // 锁精确调用形态：`autoSaveTimerRef.current = null;` 之后独立一行的
    // `flushAutoSave();`，且过期时间用 AUTO_SAVE_DEBOUNCE_MS。若把这条 save
    // 调用注释成 `// flushAutoSave();`，`\n\s*flushAutoSave` 匹配不上
    // （前面是 `// ` 不是纯空白）→ 测试红。
    assert.match(
      source,
      /setTimeout\([\s\S]{0,80}autoSaveTimerRef\.current = null;\r?\n\s*flushAutoSave\(\);[\s\S]{0,60}AUTO_SAVE_DEBOUNCE_MS\)/,
      'debounce 定时器到期必须实际执行 flushAutoSave()'
    );
  });

  it('baseUrl 为空不 upsert（避免存一堆空服务）', () => {
    assert.match(source, /values\.baseUrl\.trim\(\) === ''\s*\)\s*return;/,
      'flushAutoSave 在 baseUrl 为空时直接返回');
  });

  it('apiKey 为空不带该字段，绝不把空串覆盖到已加密凭据上', () => {
    // 载荷构造必须在 apiKey 为空时省略字段，而不是 apiKey: ''。
    assert.match(source, /\.\.\.\(values\.apiKey \? \{ apiKey: values\.apiKey \} : \{\}\)/,
      'apiKey 用条件展开，空串不带字段');
  });

  it('校验失败返回 null，调用方先判空再写盘', () => {
    // buildSavePayload 在校验失败时返回 null（不复用旧的「直接 upsert」路径）。
    assert.match(source, /temperature 需在 0–2 之间/, 'temperature 越界有错误文案');
    assert.match(source, /if \(payload === null\) return;[\s\S]{0,120}(runSave|save)/,
      '校验失败（null）时不得写盘');
  });

  it('自动保存成功文案是一行「已自动保存：<displayName>」，不模态不 toast', () => {
    assert.match(source, /setStatus\(`已自动保存：\$\{saved\.displayName\}`\)/,
      '自动保存成功文案必须是一行「已自动保存：<displayName>」');
    // 自动保存路径不得出现 pushToast / 模态。
    assert.ok(!/已自动保存[\s\S]{0,200}pushToast/.test(source), '自动保存不得触发 toast');
  });

  it('卸载（关抽屉/切走）前 cleanup 会 flush 未写完的 debounce', () => {
    assert.match(source, /useEffect\(\(\) => \{[\s\S]{0,400}flushAutoSave|void runSave\(payload\)/,
      '卸载 cleanup 必须 flush 未写完的 debounce');
    assert.match(source, /autoSaveTimerRef\.current !== null/, 'cleanup 要处理未到期的定时器');
  });

  it('手动「保存」仍是立即 flush，且成功后清空密钥输入框', () => {
    assert.match(source, /已保存模型服务：\$\{saved\.displayName\}（凭据=/, '手动保存文案保留');
    assert.match(source, /setApiKey\(''\)/, '手动保存成功清除密钥输入框');
  });
});

describe('2-A effort 官方表契约（源码级）', () => {
  it('设置页可见标签叫 effort，aria-label 也叫 effort', () => {
    assert.match(source, /effort（服务级默认）/);
    assert.match(source, /aria-label="effort"/);
    assert.ok(!source.includes('思考强度（服务级默认）'), '旧的「思考强度（服务级默认）」已改名 effort');
  });

  it('英文说明不再写 budget_tokens 数字，改锁官方 effort', () => {
    assert.match(source, /output_config\.effort = low \/ medium \/ high \/ xhigh \/ max/);
    assert.match(source, /reasoning_effort = none \/ minimal \/ low \/ medium \/ high \/ xhigh \/ max/);
    assert.ok(!source.includes('budget_tokens = 2048'), 'Anthropic 说明不得再写 budget 数字');
    assert.ok(!source.includes('deep/extreme both map to high'), 'OpenAI 说明不得再写旧映射');
  });
});

describe('provider token usage 设置面契约', () => {
  it('设置面展示历史总量、当前或最近会话上下文，并支持主动刷新', () => {
    assert.match(source, /getProviderUsageSummary\(\)/, '设置面必须从 main 读取持久化 usage');
    assert.match(source, /历史总用量/);
    assert.match(source, /当前会话.*最近会话/s);
    assert.match(source, /currentContextTokens/);
    assert.match(source, /contextSource === 'provider'/, '必须区分 provider 报告与本地估算');
    assert.match(source, /刷新用量/);
  });

  it('运行中的设置面会周期刷新，但不触发模型调用', () => {
    assert.match(source, /setInterval\([\s\S]{0,160}refreshUsage\(\)[\s\S]{0,80}3_000/);
    assert.ok(!source.includes('runAiAgent('), 'usage 刷新不得发起模型任务');
  });
});
