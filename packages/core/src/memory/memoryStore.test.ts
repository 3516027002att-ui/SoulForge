import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemoryStore, parseMemoryMarkdown, serializeMemoryMarkdown } from './memoryStore.js';

describe('Codex 长期记忆系统 (Long-Term Memory System)', () => {
  it('Markdown 解析与序列化保持一致性', () => {
    const rawMarkdown = `# Project Long-Term Memory

## [character_ids] 狼与主要角色 ID 映射
<!-- tags: character, id, wolf -->
狼的角色模型 ID 是 c0000，弦一郎是 c1000，永真是 c2200。

## [speffect_rules] 自定义 Buff 规范
<!-- tags: speffect, param -->
自定义 Buff 统一使用 880000 起始的段位。
`;

    const parsed = parseMemoryMarkdown(rawMarkdown);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0]?.topic, 'character_ids');
    assert.equal(parsed.entries[0]?.summary, '狼与主要角色 ID 映射');
    assert.equal(parsed.entries[0]?.tags?.includes('character'), true);
    assert.equal(parsed.entries[1]?.topic, 'speffect_rules');
    assert.equal(parsed.entries[1]?.summary, '自定义 Buff 规范');

    const serialized = serializeMemoryMarkdown(parsed);
    assert.equal(serialized.includes('## [character_ids] 狼与主要角色 ID 映射'), true);
    assert.equal(serialized.includes('## [speffect_rules] 自定义 Buff 规范'), true);
    assert.equal(serialized.includes('<!-- tags: character, id, wolf -->'), true);
  });

  it('InMemoryMemoryStore 支持增删改查与相关度检索', () => {
    const store = new InMemoryMemoryStore();
    
    // 存入记忆
    const entry1 = store.save({
      topic: 'character_ids',
      summary: '主要角色模型 ID 列表',
      details: '狼是 c0000，永真是 c2200',
      tags: ['model', 'character']
    });
    assert.ok(entry1.id);
    assert.equal(store.list().length, 1);

    const entry2 = store.save({
      topic: 'event_flags',
      summary: '自定义剧情 Flag 区间',
      details: '使用 900000 - 999999 之间的标志位',
      tags: ['event', 'flag']
    });
    assert.equal(store.list().length, 2);

    // 搜索
    const searchRes = store.search('永真');
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0]?.topic, 'character_ids');

    const tagSearch = store.search('flag');
    assert.equal(tagSearch.length, 1);
    assert.equal(tagSearch[0]?.topic, 'event_flags');

    // 格式化注入系统提示词
    const promptSnippet = store.formatForSystemPrompt();
    assert.equal(promptSnippet.includes('## 项目长期记忆 (Project Long-Term Memory):'), true);
    assert.equal(promptSnippet.includes('[character_ids]'), true);
    assert.equal(promptSnippet.includes('[event_flags]'), true);

    // 删除
    const deleted = store.delete('character_ids');
    assert.equal(deleted, true);
    assert.equal(store.list().length, 1);
  });
});
