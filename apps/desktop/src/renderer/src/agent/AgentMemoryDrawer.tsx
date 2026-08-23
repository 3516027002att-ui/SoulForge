import { useState, useEffect, type ReactElement } from 'react';
import type { MemoryEntry } from '@soulforge/core';

export interface AgentMemoryDrawerProps {
  onClose?: () => void;
}

export function AgentMemoryDrawer(_props: AgentMemoryDrawerProps): ReactElement {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState<string>('');
  const [editSummary, setEditSummary] = useState<string>('');
  const [editDetails, setEditDetails] = useState<string>('');
  const [editTags, setEditTags] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);

  const loadMemories = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      if (window.soulforge?.listAiMemories) {
        const result = await window.soulforge.listAiMemories();
        if (result.ok) {
          setEntries(result.entries);
        } else {
          setError(result.error.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMemories();
  }, []);

  const handleSave = async (): Promise<void> => {
    if (!editTopic.trim() || !editSummary.trim()) {
      setError('主题与摘要不能为空');
      return;
    }
    setError(null);
    try {
      if (window.soulforge?.saveAiMemory) {
        const tags = editTags.split(',').map((t) => t.trim()).filter(Boolean);
        const result = await window.soulforge.saveAiMemory({
          ...(editingId ? { id: editingId } : {}),
          topic: editTopic.trim(),
          summary: editSummary.trim(),
          details: editDetails.trim(),
          tags
        });
        if (result.ok) {
          setEditingId(null);
          setIsCreating(false);
          setEditTopic('');
          setEditSummary('');
          setEditDetails('');
          setEditTags('');
          await loadMemories();
        } else {
          setError(result.error.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    if (!window.confirm('确定删除此记忆条目？')) return;
    try {
      if (window.soulforge?.deleteAiMemory) {
        const result = await window.soulforge.deleteAiMemory(id);
        if (result.ok) {
          await loadMemories();
        } else {
          setError(result.error.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startEdit = (entry: MemoryEntry): void => {
    setIsCreating(false);
    setEditingId(entry.id);
    setEditTopic(entry.topic);
    setEditSummary(entry.summary);
    setEditDetails(entry.details ?? '');
    setEditTags(entry.tags?.join(', ') ?? '');
  };

  const startCreate = (): void => {
    setEditingId(null);
    setIsCreating(true);
    setEditTopic('');
    setEditSummary('');
    setEditDetails('');
    setEditTags('');
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setIsCreating(false);
  };

  const filteredEntries = entries.filter((entry) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      entry.topic.toLowerCase().includes(q) ||
      entry.summary.toLowerCase().includes(q) ||
      entry.details?.toLowerCase().includes(q) ||
      entry.tags?.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div className="agent-memory-drawer" data-testid="agent-memory-drawer">
      <div className="agent-memory-drawer__header">
        <p className="agent-memory-drawer__hint">
          长期记忆（Codex MEMORY.md）：保存项目事实、约定 ID、修改决策与踩坑教训。Agent 会在每轮任务中自动调用和查阅。
        </p>
        <div className="agent-memory-drawer__toolbar">
          <input
            type="text"
            className="agent-memory-drawer__search"
            placeholder="搜索长期记忆..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={startCreate}
            disabled={isCreating}
          >
            + 新增记忆
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void loadMemories()}
            title="刷新"
          >
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="agent-drawer__error" style={{ color: 'var(--danger-text)', margin: '4px 0', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {(isCreating || editingId !== null) && (
        <div className="agent-memory-editor-form">
          <div className="agent-memory-editor-form__title">
            {isCreating ? '新增长期记忆条目' : '编辑记忆条目'}
          </div>
          <label>
            主题 / 关键词 (Topic)
            <input
              type="text"
              placeholder="例如: character_ids 或 speffect_rules"
              value={editTopic}
              onChange={(e) => setEditTopic(e.target.value)}
              autoFocus
            />
          </label>
          <label>
            核心摘要 (Summary)
            <input
              type="text"
              placeholder="一句话概括要点"
              value={editSummary}
              onChange={(e) => setEditSummary(e.target.value)}
            />
          </label>
          <label>
            详细说明 / 笔记 (Details, 可选)
            <textarea
              rows={4}
              placeholder="具体细节、ID 列表、操作注意事项等"
              value={editDetails}
              onChange={(e) => setEditDetails(e.target.value)}
            />
          </label>
          <label>
            标签 (Tags, 逗号分隔)
            <input
              type="text"
              placeholder="speffect, character, param"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
            />
          </label>
          <div className="agent-memory-editor-form__actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={cancelEdit}>
              取消
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void handleSave()}>
              保存记忆
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-hint">
          正在加载长期记忆...
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="empty-hint">
          {searchQuery ? '未找到匹配的记忆条目' : '暂无记忆条目。Agent 在交互中自主发现的事实或用户手动添加的笔记将保存在此处。'}
        </div>
      ) : (
        <div className="agent-memory-list">
          {filteredEntries.map((entry) => (
            <div
              key={entry.id}
              className="agent-memory-item"
            >
              <div className="agent-memory-item__head">
                <div className="agent-memory-item__title">
                  <span className="agent-memory-item__topic">
                    {entry.topic}
                  </span>
                  <strong className="agent-memory-item__summary">{entry.summary}</strong>
                </div>
                <div className="agent-memory-item__actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => startEdit(entry)}
                    title="编辑"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => void handleDelete(entry.id)}
                    title="删除"
                  >
                    删除
                  </button>
                </div>
              </div>

              {entry.details && (
                <div className="agent-memory-item__details">
                  {entry.details}
                </div>
              )}

              {entry.tags && entry.tags.length > 0 && (
                <div className="agent-memory-item__tags">
                  {entry.tags.map((tag) => (
                    <span
                      key={tag}
                      className="agent-memory-tag"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
