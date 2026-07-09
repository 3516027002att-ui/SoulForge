import { useMemo, useState, type ReactElement } from 'react';
import type {
  BridgeResult,
  ContainerReadHint,
  ContainerReadSummary,
  Diagnostic,
  IndexedFile,
  MapExport,
  ParamExport,
  PatchHistoryEntry,
  ResourceKind,
  ResourcePreview,
  ResourceStructuredPreview,
  TextEntrySymbol,
  WorkspaceScanResult,
  WorkspaceSessionMeta
} from '@soulforge/shared';
import type { AnalyzeWorkspaceSummary } from '../../main/ipc.js';
import type {
  AiPermissionMode,
  AiProvider,
  AiSidebarDraft,
  AiSidebarDraftRequest,
  AiThinkingLevel,
  ToolDescriptor,
  ToolResult
} from '@soulforge/core';

const RESOURCE_KIND_ORDER: ResourceKind[] = ['event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'sfx', 'chr', 'obj', 'other', 'unknown'];

type WorkspaceMode = ResourceKind | 'files' | 'ai' | 'settings';

const WORKSPACE_MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: 'files', label: 'Files' },
  { id: 'event', label: 'Event' },
  { id: 'map', label: 'Map' },
  { id: 'param', label: 'Param' },
  { id: 'msg', label: 'Msg' },
  { id: 'menu', label: 'Menu' },
  { id: 'script', label: 'Script' },
  { id: 'action', label: 'Action' },
  { id: 'chr', label: 'Chr' },
  { id: 'obj', label: 'Obj' },
  { id: 'sfx', label: 'Sfx' },
  { id: 'other', label: 'Other' },
  { id: 'ai', label: 'AI' },
  { id: 'settings', label: 'Settings' }
];

interface EditableMsgRow {
  textId: string;
  text: string;
  category?: string;
}

export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceScanResult | null>(null);
  const [sessionMeta, setSessionMeta] = useState<WorkspaceSessionMeta | null>(null);
  const [baseRootChoice, setBaseRootChoice] = useState<string | null>(null);
  const [operationHistory, setOperationHistory] = useState<PatchHistoryEntry[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeWorkspaceSummary | null>(null);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [selectedFile, setSelectedFile] = useState<IndexedFile | null>(null);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [editText, setEditText] = useState('');
  const [lastSavedText, setLastSavedText] = useState('');
  const [msgRows, setMsgRows] = useState<EditableMsgRow[]>([]);
  const [saveDiagnostics, setSaveDiagnostics] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [eventUri, setEventUri] = useState('');
  const [toolOutput, setToolOutput] = useState<ToolResult | null>(null);
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [allFiles, setAllFiles] = useState<IndexedFile[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('files');
  const [status, setStatus] = useState('就绪');

  const [aiProvider, setAiProvider] = useState<AiProvider>('mock');
  const [aiThinking, setAiThinking] = useState<AiThinkingLevel>('normal');
  const [aiMode, setAiMode] = useState<AiPermissionMode>('plan');
  const [aiPrompt, setAiPrompt] = useState('解释当前资源的证据链，并给出下一步安全修改计划。');
  const [aiDraft, setAiDraft] = useState<AiSidebarDraft | null>(null);

  const counts = useMemo(() => workspace?.countsByKind ?? null, [workspace]);
  const diagnostics = [...(workspace?.diagnostics ?? []), ...(analysis?.diagnostics ?? []), ...(preview?.diagnostics ?? [])];
  const groupedTools = useMemo(() => groupToolsByPermission(tools), [tools]);
  const canEditText = preview?.previewKind === 'text' && preview.structuredPreview?.editable === true && !preview.truncated;
  const hasMsgTable = canEditText && msgRows.length > 0;
  const editDirty = editText !== lastSavedText;
  const visibleFiles = useMemo(
    () => filterFilesForMode(allFiles.length > 0 ? allFiles : files, workspaceMode, query),
    [allFiles, files, workspaceMode, query]
  );

  async function refreshOperationHistory(): Promise<void> {
    const history = await window.soulforge.listOperations();
    setOperationHistory(history);
  }

  async function chooseBaseDirectory(): Promise<void> {
    const baseRoot = await window.soulforge.openBaseDialog();
    if (!baseRoot) return;
    setBaseRootChoice(baseRoot);
    setStatus(`已选择只读 Base：${baseRoot}（下次打开 Mod 工作区时生效）`);
  }

  function clearBaseDirectory(): void {
    setBaseRootChoice(null);
    setStatus('已清除 Base 目录选择');
  }

  async function openWorkspace(): Promise<void> {
    const workspaceRoot = await window.soulforge.openWorkspaceDialog();
    if (!workspaceRoot) return;

    setStatus('正在扫描工作区...');
    const result = await window.soulforge.scanWorkspace({
      workspaceRoot,
      ...(baseRootChoice ? { baseRoot: baseRootChoice } : {})
    });
    setWorkspace(result);
    setSessionMeta(result.session ?? null);
    setAllFiles(result.files);
    setFiles(result.files);
    setWorkspaceMode('files');
    setSelectedFile(null);
    setPreview(null);
    setEditText('');
    setLastSavedText('');
    setMsgRows([]);
    setSaveDiagnostics([]);
    setAnalysis(null);
    setToolOutput(null);
    setAiDraft(null);
    setOperationHistory([]);

    setStatus('正在构建轻量证据索引...');
    const nextAnalysis = await window.soulforge.analyzeWorkspace(workspaceRoot);
    setAnalysis(nextAnalysis);
    setTools(nextAnalysis.tools);
    setEventUri(nextAnalysis.events[0]?.uri ?? '');
    await refreshOperationHistory();
    const baseLabel = result.session?.layers.baseRoot
      ? ` · base 只读已挂载`
      : ' · 未挂载 base';
    setStatus(`已索引并可打开 ${result.files.length} 个文件，解析 ${nextAnalysis.parsedFiles} 个文本/mock 资源${baseLabel}`);
  }

  async function search(): Promise<void> {
    const result = await window.soulforge.searchResources(query);
    setAllFiles(result);
    setFiles(result);
    setStatus(`搜索返回 ${result.length} 个文件`);
  }

  function switchMode(mode: WorkspaceMode): void {
    setWorkspaceMode(mode);
    if (mode === 'ai') {
      setStatus('AI 侧边栏已聚焦：计划优先，写入必须经过 Patch Engine');
      return;
    }
    if (mode === 'settings') {
      setStatus('设置：Provider / 思考强度 / 权限模式见右侧 AI 面板');
      return;
    }
    const filtered = filterFilesForMode(allFiles, mode, query);
    setStatus(mode === 'files'
      ? `Files mode：${filtered.length} 个文件`
      : `${mode} mode：${filtered.length} 个资源`);
  }

  async function selectFile(file: IndexedFile): Promise<void> {
    setSelectedFile(file);
    setPreview(null);
    setEditText('');
    setLastSavedText('');
    setMsgRows([]);
    setSaveDiagnostics([]);
    setAiDraft(null);
    setStatus(`正在打开 ${file.relativePath}...`);
    const nextPreview = await window.soulforge.openResourcePreview(file.sourceUri);
    setPreview(nextPreview);
    const text = nextPreview?.text ?? '';
    setEditText(text);
    setLastSavedText(text);
    setMsgRows(extractMsgRows(nextPreview));
    setStatus(nextPreview ? `已打开 ${file.relativePath}` : '无法预览该资源');
  }

  async function saveCurrentText(): Promise<void> {
    if (!selectedFile || !preview) return;
    setStatus(`正在保存 ${selectedFile.relativePath}...`);
    const result = await window.soulforge.saveTextResource(selectedFile.sourceUri, editText);
    setSaveDiagnostics(result.diagnostics.map((diagnostic: Diagnostic) => `${diagnostic.code}: ${diagnostic.message}`));

    if (!result.ok) {
      setStatus(`保存失败：${selectedFile.relativePath}`);
      return;
    }

    const refreshed = await window.soulforge.openResourcePreview(selectedFile.sourceUri);
    setPreview(refreshed);
    const text = refreshed?.text ?? editText;
    setEditText(text);
    setLastSavedText(text);
    setMsgRows(extractMsgRows(refreshed));
    await refreshOperationHistory();
    setStatus(`已保存 ${selectedFile.relativePath}，备份目录：${result.backupRoot ?? 'unknown'}`);
  }

  async function rollbackOp(opId: string): Promise<void> {
    setStatus(`正在回滚操作 ${opId.slice(0, 8)}...`);
    const result = await window.soulforge.rollbackOperation(opId);
    await refreshOperationHistory();
    if (!result.ok) {
      setStatus(`回滚失败：${result.diagnostics.map((d: Diagnostic) => d.message).join('; ') || opId}`);
      return;
    }
    if (selectedFile) {
      const refreshed = await window.soulforge.openResourcePreview(selectedFile.sourceUri);
      setPreview(refreshed);
      const text = refreshed?.text ?? '';
      setEditText(text);
      setLastSavedText(text);
      setMsgRows(extractMsgRows(refreshed));
    }
    setStatus(`已回滚 ${result.restoredFiles.length} 个文件`);
  }

  function updateMsgRow(index: number, patch: Partial<EditableMsgRow>): void {
    const nextRows = msgRows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
    setMsgRows(nextRows);
    setEditText(serializeMsgRowsToTsv(nextRows));
  }

  function addMsgRow(): void {
    const nextRows = [...msgRows, { textId: nextMsgId(msgRows), text: '', ...(msgRows[0]?.category ? { category: msgRows[0].category } : {}) }];
    setMsgRows(nextRows);
    setEditText(serializeMsgRowsToTsv(nextRows));
  }

  function removeMsgRow(index: number): void {
    const nextRows = msgRows.filter((_row, rowIndex) => rowIndex !== index);
    setMsgRows(nextRows);
    setEditText(serializeMsgRowsToTsv(nextRows));
  }

  async function buildAiDraft(): Promise<void> {
    const request: AiSidebarDraftRequest = {
      settings: {
        provider: aiProvider,
        thinking: aiThinking,
        mode: aiMode
      },
      userPrompt: aiPrompt,
      context: {
        ...(workspace?.workspaceRoot ? { workspaceRoot: workspace.workspaceRoot } : {}),
        ...(selectedFile
          ? {
              selectedResource: {
                sourceUri: selectedFile.sourceUri,
                relativePath: selectedFile.relativePath,
                resourceKind: selectedFile.resourceKind
              }
            }
          : {}),
        ...(preview?.previewKind ? { previewKind: preview.previewKind } : {}),
        diagnosticsCount: diagnostics.length,
        ...(analysis?.referenceStats ? { referenceStats: analysis.referenceStats } : {}),
        ...(eventUri ? { currentEventUri: eventUri } : {})
      },
      availableTools: tools
    };

    setStatus('正在生成 AI 计划草稿...');
    const draft = await window.soulforge.buildAiSidebarDraft(request);
    setAiDraft(draft);
    setStatus(draft.status === 'ready' ? 'AI 计划草稿已生成' : 'AI Provider 尚未配置，已生成本地计划草稿');
  }

  async function runToolSearch(): Promise<void> {
    const result = await window.soulforge.runAiTool('search_resources', { query: toolQuery, limit: 8 }, aiMode);
    setToolOutput(result);
  }

  async function explainEvent(): Promise<void> {
    const result = await window.soulforge.runAiTool('explain_event', { uri: eventUri }, aiMode);
    setToolOutput(result);
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <section>
          <h1>SoulForge</h1>
          <p>魂游 Mod 的 Cursor · v0.5 foundation | Overlay 可写 · Base 只读 · Patch Engine 唯一写入</p>
        </section>
        <div className="top-bar-actions">
          <button type="button" className="secondary-action" onClick={() => void chooseBaseDirectory()}>
            {baseRootChoice ? '更换 Base 目录' : '选择 Base（可选）'}
          </button>
          {baseRootChoice && (
            <button type="button" className="ghost-action" onClick={clearBaseDirectory}>清除 Base</button>
          )}
          <button type="button" onClick={() => void openWorkspace()}>打开 Mod 工作区</button>
        </div>
      </header>

      <nav className="mode-tabs" aria-label="editor modes">
        {WORKSPACE_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={workspaceMode === mode.id ? (mode.id === 'ai' ? 'active ai-tab' : 'active') : mode.id === 'ai' ? 'ai-tab' : undefined}
            onClick={() => switchMode(mode.id)}
          >
            {mode.label}
            {counts && isResourceKindMode(mode.id) ? ` ${counts[mode.id] ?? 0}` : ''}
          </button>
        ))}
      </nav>

      <section className="workspace-summary">
        <div className="workspace-summary-lines">
          <div>
            <strong>Workspace (overlay):</strong> {workspace?.workspaceRoot ?? '未打开'}
            <span className="mode-badge">{workspaceMode === 'files' ? 'Files mode' : `${workspaceMode} mode`}</span>
          </div>
          <div>
            <strong>Base (readonly):</strong>{' '}
            {sessionMeta?.layers.baseRoot
              ?? baseRootChoice
              ?? (sessionMeta ? '未挂载' : '打开工作区前可先选')}
            {sessionMeta && (
              <span className={sessionMeta.baseMissing ? 'base-pill missing' : 'base-pill ready'}>
                {sessionMeta.baseMissing ? 'base missing' : 'base mounted'}
              </span>
            )}
          </div>
        </div>
        {counts && (
          <div className="counts">
            {RESOURCE_KIND_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                className={workspaceMode === kind ? 'count-chip active' : 'count-chip'}
                onClick={() => switchMode(kind)}
              >
                {kind}: {counts[kind]}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="content-grid">
        <aside className="resource-pane">
          <div className="search-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索路径 / 类型"
            />
            <button type="button" onClick={search}>搜索</button>
          </div>
          <div className="file-list">
            {visibleFiles.map((file) => (
              <button
                type="button"
                key={file.sourceUri}
                className={selectedFile?.sourceUri === file.sourceUri ? 'file-item selected' : 'file-item'}
                onClick={() => void selectFile(file)}
              >
                <span>{file.relativePath}</span>
                <small>{file.resourceKind} | {file.formatLabel} | {(file.size / 1024).toFixed(1)} KB</small>
              </button>
            ))}
            {visibleFiles.length === 0 && (
              <p className="muted pane-empty">当前模式没有匹配资源。可切换到 Files 或调整搜索。</p>
            )}
          </div>
        </aside>

        <section className="viewer-pane">
          <h2>{selectedFile?.relativePath ?? '资源预览'}</h2>
          {!selectedFile && <p className="muted">选择左侧资源后显示限量文本或十六进制预览。</p>}
          {preview?.structuredPreview && <StructuredPreviewCard preview={preview.structuredPreview} />}
          {preview?.nativeInspection && <NativeInspectionCard inspection={preview.nativeInspection} />}
          {preview?.previewKind === 'text' && (
            <section className="text-editor-panel">
              <div className="text-editor-toolbar">
                <strong>{canEditText ? 'Text editor' : 'Text preview'}</strong>
                <div>
                  <button type="button" disabled={!canEditText || !editDirty} onClick={() => void saveCurrentText()}>保存</button>
                  <button type="button" disabled={!editDirty} onClick={() => setEditText(lastSavedText)}>还原</button>
                </div>
              </div>
              {!canEditText && <p className="muted">该资源当前只读。原因通常是预览被截断、不是文本资源，或原生二进制写回器尚未启用。</p>}
              {hasMsgTable && (
                <MsgTableEditor
                  rows={msgRows}
                  onAdd={addMsgRow}
                  onRemove={removeMsgRow}
                  onUpdate={updateMsgRow}
                />
              )}
              <textarea
                value={editText}
                readOnly={!canEditText}
                onChange={(event) => setEditText(event.target.value)}
                spellCheck={false}
              />
              {saveDiagnostics.length > 0 && (
                <div className="save-diagnostics">
                  {saveDiagnostics.map((message) => <span key={message}>{message}</span>)}
                </div>
              )}
            </section>
          )}
          {preview?.previewKind === 'hex' && <pre>{preview.hex}</pre>}
          {preview?.previewKind === 'empty' && <p className="muted">空文件。</p>}
          {preview?.previewKind === 'failed' && <p className="danger">预览失败。</p>}
          {preview?.truncated && <p className="muted">预览只读取文件前缀，确保大型 DCX/BND 等二进制文件也能安全打开。</p>}
        </section>

        <aside className="ai-pane">
          <div className="ai-pane-header">
            <div>
              <h2>AI 侧边栏</h2>
              <p>计划优先，证据优先，写入必须经过 Patch Engine。</p>
            </div>
            <span className={aiProvider === 'mock' ? 'provider-pill ready' : 'provider-pill'}>
              {aiProvider === 'mock' ? 'local draft' : 'needs config'}
            </span>
          </div>

          <div className="ai-control-grid">
            <label>
              Provider
              <select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as AiProvider)}>
                <option value="mock">Mock / Local Planner</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label>
              Thinking
              <select value={aiThinking} onChange={(event) => setAiThinking(event.target.value as AiThinkingLevel)}>
                <option value="fast">fast</option>
                <option value="normal">normal</option>
                <option value="deep">deep</option>
                <option value="extreme">extreme</option>
              </select>
            </label>
            <label>
              Mode
              <select value={aiMode} onChange={(event) => setAiMode(event.target.value as AiPermissionMode)}>
                <option value="plan">plan</option>
                <option value="normal">normal</option>
                <option value="fullPermission">full permission</option>
              </select>
            </label>
          </div>

          <div className="context-card ai-context-card">
            <strong>Current context</strong>
            <span>{selectedFile?.sourceUri ?? 'No resource selected'}</span>
            {analysis && <span>refs: H{analysis.referenceStats.high} / M{analysis.referenceStats.medium} / L{analysis.referenceStats.low}</span>}
            <span>{diagnostics.length ? `${diagnostics.length} diagnostics in scope` : 'No diagnostics in scope'}</span>
          </div>

          <label className="ai-prompt-box">
            Goal
            <textarea
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder="例如：解释当前事件引用了哪些文本和参数，并提出安全修改计划。"
            />
          </label>
          <button className="primary-action" type="button" onClick={() => void buildAiDraft()}>生成计划草稿</button>

          {aiDraft && (
            <section className="ai-draft-card">
              <div className="ai-draft-title">
                <strong>{aiDraft.title}</strong>
                <span>{aiDraft.provider} / {aiDraft.thinking} / {aiDraft.mode}</span>
              </div>
              <p>{aiDraft.summary}</p>

              <div className="ai-mini-section">
                <strong>建议工具</strong>
                {aiDraft.recommendedTools.length === 0 && <span className="muted">暂无建议。</span>}
                {aiDraft.recommendedTools.map((tool) => (
                  <span key={tool.toolName} className="tool-chip" title={tool.reason}>{tool.toolName}</span>
                ))}
              </div>

              <div className="ai-mini-section">
                <strong>下一步</strong>
                <ol>
                  {aiDraft.nextActions.map((action) => <li key={action}>{action}</li>)}
                </ol>
              </div>

              <details>
                <summary>Prompt preview</summary>
                <pre className="tool-output">{aiDraft.promptPreview}</pre>
              </details>
            </section>
          )}

          <div className="tool-panel">
            <strong>Safe tools</strong>
            <div className="tool-group">
              <small>read / analyze</small>
              <div className="tool-list">
                {groupedTools.read.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)}
              </div>
            </div>
            <div className="tool-group">
              <small>propose / validate</small>
              <div className="tool-list">
                {groupedTools.plan.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)}
              </div>
            </div>
            <div className="tool-group">
              <small>commit / rollback</small>
              <div className="tool-list">
                {groupedTools.write.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)}
              </div>
            </div>
            <div className="tool-row">
              <input value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} placeholder="search_resources query" />
              <button type="button" onClick={() => void runToolSearch()}>Run</button>
            </div>
            <div className="tool-row">
              <input value={eventUri} onChange={(event) => setEventUri(event.target.value)} placeholder="event://..." />
              <button type="button" onClick={() => void explainEvent()}>Explain</button>
            </div>
          </div>

          {analysis && (
            <div className="context-card">
              <strong>Evidence index</strong>
              <span>parsed: {analysis.parsedFiles}</span>
              <span>inspected: {analysis.inspectedFiles}</span>
              <span>refs: H{analysis.referenceStats.high} / M{analysis.referenceStats.medium} / L{analysis.referenceStats.low}</span>
            </div>
          )}

          <section className="operation-history-panel">
            <div className="operation-history-header">
              <strong>操作历史</strong>
              <button type="button" className="ghost-action" disabled={!workspace} onClick={() => void refreshOperationHistory()}>
                刷新
              </button>
            </div>
            {!workspace && <p className="muted">打开工作区并完成至少一次 Patch 提交后可在此回滚。</p>}
            {workspace && operationHistory.length === 0 && (
              <p className="muted">尚无已记录操作。保存文本资源后会写入落盘 operation log。</p>
            )}
            <div className="operation-history-list">
              {operationHistory.map((entry) => (
                <div key={entry.opId} className="operation-history-item">
                  <div className="operation-history-meta">
                    <strong title={entry.opId}>{entry.title}</strong>
                    <span className={`op-status op-status-${entry.status}`}>{entry.status}</span>
                    <small>
                      {entry.fileCount} file(s) · {entry.committedAt ?? entry.createdAt}
                    </small>
                    <small className="muted" title={entry.changedPaths.join('\n')}>
                      {entry.changedPaths[0] ? shortenPath(entry.changedPaths[0]) : '—'}
                      {entry.changedPaths.length > 1 ? ` +${entry.changedPaths.length - 1}` : ''}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={entry.status !== 'committed'}
                    onClick={() => void rollbackOp(entry.opId)}
                  >
                    回滚
                  </button>
                </div>
              ))}
            </div>
          </section>

          {toolOutput && <pre className="tool-output">{JSON.stringify(toolOutput, null, 2)}</pre>}
        </aside>
      </section>

      <footer className="status-bar">
        <span>{status}</span>
        <span>{diagnostics.length ? `${diagnostics.length} diagnostics` : 'No diagnostics'}</span>
      </footer>
    </main>
  );
}

function MsgTableEditor({
  rows,
  onAdd,
  onRemove,
  onUpdate
}: {
  rows: EditableMsgRow[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<EditableMsgRow>) => void;
}): ReactElement {
  return (
    <section className="msg-table-editor">
      <div className="msg-table-toolbar">
        <strong>MSG table</strong>
        <button type="button" onClick={onAdd}>新增文本</button>
      </div>
      <div className="msg-table-grid msg-table-header">
        <span>ID</span>
        <span>Text</span>
        <span>Action</span>
      </div>
      {rows.map((row, index) => (
        <div className="msg-table-grid" key={`${row.textId}-${index}`}>
          <input
            value={row.textId}
            onChange={(event) => onUpdate(index, { textId: event.target.value })}
            aria-label="text id"
          />
          <textarea
            value={row.text}
            onChange={(event) => onUpdate(index, { text: event.target.value })}
            aria-label="text value"
          />
          <button type="button" onClick={() => onRemove(index)}>删除</button>
        </div>
      ))}
      <p className="muted">表格编辑会同步生成规范 TSV 文本；保存仍走 Patch Engine，并会自动备份原文件。</p>
    </section>
  );
}

function StructuredPreviewCard({ preview }: { preview: ResourceStructuredPreview }): ReactElement {
  const eventCount = preview.events?.reduce((total, eventExport) => total + eventExport.events.length, 0) ?? 0;
  const instructionCount = preview.events?.reduce(
    (total, eventExport) => total + eventExport.events.reduce((sum, event) => sum + event.instructions.length, 0),
    0
  ) ?? 0;
  const msgCount = preview.msgs?.reduce((total, msgExport) => total + msgExport.entries.length, 0) ?? 0;
  const paramRows = collectParamRows(preview.params);
  const paramFieldCount = paramRows.reduce((total, row) => total + (row.fields?.length ?? 0), 0);
  const mapEntities = collectMapEntities(preview.maps);
  const mapRegions = preview.maps?.flatMap((mapExport) => mapExport.regions) ?? [];

  return (
    <section className="structured-preview-card">
      <div className="structured-preview-title">
        <strong>Structured preview</strong>
        <span>{preview.parser} / {preview.status}</span>
      </div>
      <p>{preview.summary}</p>
      <div className="structured-preview-grid">
        <span>kind: {preview.kind}</span>
        <span>editable: {preview.editable ? 'yes' : 'no'}</span>
        <span>events: {eventCount}</span>
        <span>instructions: {instructionCount}</span>
        <span>texts: {msgCount}</span>
        <span>param rows: {paramRows.length}</span>
        <span>param fields: {paramFieldCount}</span>
        <span>map entities: {mapEntities.length}</span>
        <span>map regions: {mapRegions.length}</span>
        <span>diagnostics: {preview.diagnostics.length}</span>
      </div>
      <EditCapabilityStrip preview={preview} />
      {preview.events && preview.events.length > 0 && (
        <details>
          <summary>Events</summary>
          <div className="structured-symbol-list">
            {preview.events.flatMap((eventExport) => eventExport.events).slice(0, 24).map((event) => (
              <span key={event.uri}>{event.eventId}{event.name ? ` · ${event.name}` : ''} · {event.instructions.length} instr</span>
            ))}
          </div>
        </details>
      )}
      {paramRows.length > 0 && (
        <details>
          <summary>Param rows</summary>
          <div className="structured-symbol-list">
            {paramRows.slice(0, 32).map((row) => (
              <span key={row.uri} title={formatParamFieldPreview(row.fields)}>
                {row.paramName} · {row.rowId}{row.rowName ? ` · ${row.rowName}` : ''} · {row.fields?.length ?? 0} field(s)
              </span>
            ))}
          </div>
        </details>
      )}
      {mapEntities.length > 0 && (
        <details>
          <summary>Map entities</summary>
          <div className="structured-symbol-list">
            {mapEntities.slice(0, 32).map((entity) => (
              <span key={entity.uri} title={formatVectorPreview(entity.position)}>
                {entity.mapId} · {entity.entityId ?? 'candidate'} · {entity.kind} · {entity.name}{entity.model ? ` · ${entity.model}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}
      {mapRegions.length > 0 && (
        <details>
          <summary>Map regions</summary>
          <div className="structured-symbol-list">
            {mapRegions.slice(0, 32).map((region) => (
              <span key={region.uri} title={formatVectorPreview(region.position)}>
                {region.mapId} · {region.entityId ?? 'candidate'} · {region.name}{region.shape ? ` · ${region.shape}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}
      {preview.msgs && preview.msgs.length > 0 && (
        <details>
          <summary>Text entries</summary>
          <div className="structured-symbol-list">
            {preview.msgs.flatMap((msgExport) => msgExport.entries).slice(0, 24).map((entry) => (
              <span key={entry.uri}>{entry.textId} · {entry.text.slice(0, 80)}</span>
            ))}
          </div>
        </details>
      )}
      {preview.container && <ContainerReadCard container={preview.container} />}
    </section>
  );
}

function EditCapabilityStrip({ preview }: { preview: ResourceStructuredPreview }): ReactElement {
  const hasNativeSemanticData = Boolean(preview.events?.length || preview.maps?.length || preview.params?.length || preview.msgs?.length);
  const hasContainerData = Boolean(preview.container);

  return (
    <div className="edit-capability-strip" aria-label="edit capability">
      <span className={preview.editable ? 'capability-pill ready' : 'capability-pill blocked'}>
        text: {preview.editable ? 'editable via Patch Engine' : 'read-only'}
      </span>
      <span className="capability-pill blocked">
        native: {hasNativeSemanticData ? 'parsed preview only' : 'no writer contract'}
      </span>
      <span className="capability-pill blocked">
        container: {hasContainerData ? 'child replacement disabled' : 'not a container preview'}
      </span>
    </div>
  );
}

function collectParamRows(params: ParamExport[] | undefined): ParamExport['rows'] {
  return params?.flatMap((paramExport) => paramExport.rows) ?? [];
}

function collectMapEntities(maps: MapExport[] | undefined): MapExport['entities'] {
  return maps?.flatMap((mapExport) => mapExport.entities) ?? [];
}

function formatParamFieldPreview(fields: ParamExport['rows'][number]['fields']): string {
  if (!fields || fields.length === 0) return 'No typed fields are available yet.';
  return fields.slice(0, 6).map((field) => `${field.name}=${String(field.value)}`).join(', ');
}

function formatVectorPreview(value: [number, number, number] | undefined): string {
  return value ? `position=${value.map((item) => item.toFixed(3)).join(', ')}` : 'No transform evidence is available yet.';
}

function ContainerReadCard({ container }: { container: ContainerReadSummary }): ReactElement {
  const childHints = container.hints.filter((hint) => hint.kind === 'binderChildCandidate' || hint.kind === 'pathHint');
  const confirmedBinderHints = container.hints.filter((hint) => hint.kind === 'binderChildTable' || hint.kind === 'dcxNestedBinderChildTable');
  const nestedHints = container.hints.filter((hint) => hint.kind === 'nestedMagicCandidate');

  return (
    <section className="container-read-card">
      <div className="container-read-title">
        <strong>Container read</strong>
        <span>{container.rootFormat ?? 'unknown'}</span>
      </div>
      <div className="container-read-grid">
        <span>file: {container.fileName ?? 'unknown'}</span>
        <span>size: {container.fileSize !== undefined ? `${(container.fileSize / 1024).toFixed(1)} KB` : 'unknown'}</span>
        <span>paths: {container.pathHintCount}</span>
        <span>candidate children: {container.binderChildCandidateCount}</span>
        <span>confirmed tables: {(container.binderChildTableCount ?? 0) + (container.dcxNestedBinderChildTableCount ?? 0)}</span>
        <span>nested magic: {container.nestedMagicCandidateCount}</span>
        <span>ext: {container.extensionChain.join(' ') || 'none'}</span>
      </div>
      {confirmedBinderHints.length > 0 && <BinderChildTable hints={confirmedBinderHints} />}
      {childHints.length > 0 && <ContainerHintList title="Path / child candidates" hints={childHints} />}
      {nestedHints.length > 0 && <ContainerHintList title="Nested format candidates" hints={nestedHints} />}
      <p className="muted">high confidence 的 BND 子表仍只代表已验证的 SoulForge fixture；真实原生 BND 写回前还需要 native fixture 和 writer contract。</p>
    </section>
  );
}

interface BinderChildRow {
  id?: number;
  name?: string;
  resourceKind?: string;
  offset?: number;
  packedSize?: number;
  unpackedSize?: number;
}

function BinderChildTable({ hints }: { hints: ContainerReadHint[] }): ReactElement {
  const rows = hints.flatMap((hint) => extractBinderChildRows(hint.raw));

  if (rows.length === 0) {
    return <ContainerHintList title="Confirmed binder child tables" hints={hints} />;
  }

  return (
    <details>
      <summary>Confirmed binder child rows</summary>
      <div className="binder-child-table" role="table" aria-label="confirmed binder child rows">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>Name</span>
          <span>Kind</span>
          <span>Offset</span>
          <span>Packed</span>
          <span>Unpacked</span>
        </div>
        {rows.slice(0, 80).map((row, index) => (
          <div className="binder-child-row" role="row" key={`${row.name ?? 'child'}-${row.id ?? index}-${index}`}>
            <span>{row.id ?? '—'}</span>
            <span title={row.name ?? ''}>{row.name ?? 'unknown'}</span>
            <span>{row.resourceKind ?? 'unknown'}</span>
            <span>{formatMaybeNumber(row.offset)}</span>
            <span>{formatMaybeNumber(row.packedSize)}</span>
            <span>{formatMaybeNumber(row.unpackedSize)}</span>
          </div>
        ))}
      </div>
      <p className="muted">子文件表是只读 inventory。替换 child、重打包和写回要等 BND writer contract。</p>
    </details>
  );
}

function extractBinderChildRows(raw: unknown): BinderChildRow[] {
  const record = asUiRecord(raw);
  const nestedData = asUiRecord(record.data ?? record.Data);
  const children = Array.isArray(record.children) ? record.children : Array.isArray(nestedData.children) ? nestedData.children : [];

  return children
    .map((child) => asBinderChildRow(child))
    .filter((child): child is BinderChildRow => child !== null);
}

function asBinderChildRow(value: unknown): BinderChildRow | null {
  const record = asUiRecord(value);
  const id = readFiniteNumber(record.id);
  const name = readString(record.name);
  const resourceKind = readString(record.resourceKind);
  const offset = readFiniteNumber(record.offset);
  const packedSize = readFiniteNumber(record.packedSize);
  const unpackedSize = readFiniteNumber(record.unpackedSize);

  if (id === undefined && !name && offset === undefined) return null;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(name ? { name } : {}),
    ...(resourceKind ? { resourceKind } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(packedSize !== undefined ? { packedSize } : {}),
    ...(unpackedSize !== undefined ? { unpackedSize } : {})
  };
}

function asUiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatMaybeNumber(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

function ContainerHintList({ title, hints }: { title: string; hints: ContainerReadHint[] }): ReactElement {
  return (
    <details>
      <summary>{title}</summary>
      <div className="container-hint-list">
        {hints.slice(0, 40).map((hint, index) => (
          <span key={`${hint.kind}-${hint.offset}-${index}`} title={JSON.stringify(hint.raw ?? {})}>
            {hint.offset.toString(16).padStart(8, '0')} · {hint.label} · {hint.resourceKind ?? hint.rootFormat ?? 'unknown'} · {hint.confidence}
          </span>
        ))}
      </div>
    </details>
  );
}

function extractMsgRows(preview: ResourcePreview | null | undefined): EditableMsgRow[] {
  return preview?.structuredPreview?.msgs
    ?.flatMap((msgExport) => msgExport.entries.map((entry) => msgEntryToEditableRow(entry, msgExport.category)))
    ?? [];
}

function msgEntryToEditableRow(entry: TextEntrySymbol, fallbackCategory?: string): EditableMsgRow {
  const category = entry.category ?? fallbackCategory;
  return {
    textId: String(entry.textId),
    text: entry.text,
    ...(category ? { category } : {})
  };
}

function serializeMsgRowsToTsv(rows: EditableMsgRow[]): string {
  return `${rows.map((row) => `${sanitizeTextId(row.textId)}\t${escapeTsvText(row.text)}`).join('\n')}\n`;
}

function sanitizeTextId(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : '0';
}

function escapeTsvText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '\\n').replaceAll('\t', ' ');
}

function nextMsgId(rows: EditableMsgRow[]): string {
  const maxId = rows.reduce((max, row) => {
    const id = Number.parseInt(row.textId, 10);
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
  return String(maxId + 1);
}

interface NativeInspectionData {
  file?: {
    fileName?: string;
    size?: number;
    extension?: string;
    extensionChain?: string[];
  };
  resourceKind?: string;
  rootFormat?: string;
  parseStatus?: string;
  layers?: NativeInspectionLayer[];
  evidence?: NativeInspectionEvidence[];
  nextSteps?: string[];
}

interface NativeInspectionLayer {
  format?: string;
  offset?: number;
  length?: number;
  confidence?: string;
  metadata?: unknown;
}

interface NativeInspectionEvidence {
  kind?: string;
  offset?: number;
  value?: unknown;
  confidence?: string;
}

function NativeInspectionCard({ inspection }: { inspection: BridgeResult<unknown> }): ReactElement {
  const data = asNativeInspectionData(inspection.data);
  const layers = data?.layers ?? [];
  const evidence = data?.evidence ?? [];
  const nextSteps = data?.nextSteps ?? [];

  return (
    <section className="native-inspection-card">
      <div className="native-inspection-title">
        <strong>Native inspect</strong>
        <span>{inspection.parseStatus}</span>
      </div>
      <div className="native-inspection-grid">
        <span>kind: {data?.resourceKind ?? inspection.resourceKind}</span>
        <span>root: {data?.rootFormat ?? 'unknown'}</span>
        <span>layers: {layers.length}</span>
        <span>evidence: {evidence.length}</span>
      </div>
      {layers.length > 0 && (
        <div className="native-chip-row">
          {layers.slice(0, 6).map((layer, index) => (
            <span key={`${layer.format ?? 'layer'}-${index}`} title={describeLayer(layer)}>
              {layer.format ?? 'unknown'} · {layer.confidence ?? 'unknown'}
            </span>
          ))}
        </div>
      )}
      {evidence.length > 0 && (
        <details>
          <summary>Evidence clues</summary>
          <ul className="native-evidence-list">
            {evidence.slice(0, 12).map((item, index) => (
              <li key={`${item.kind ?? 'evidence'}-${index}`}>
                <strong>{item.kind ?? 'unknown'}</strong>
                <span>offset={item.offset ?? 0}</span>
                <span>confidence={item.confidence ?? 'unknown'}</span>
                <code>{summarizeEvidenceValue(item.value)}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {nextSteps.length > 0 && (
        <details>
          <summary>Bridge notes</summary>
          <ol>
            {nextSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </details>
      )}
    </section>
  );
}

function asNativeInspectionData(value: unknown): NativeInspectionData | null {
  if (!value || typeof value !== 'object') return null;
  return value as NativeInspectionData;
}

function describeLayer(layer: NativeInspectionLayer): string {
  const offset = layer.offset ?? 0;
  const length = layer.length ?? 0;
  return `offset=${offset}, length=${length}`;
}

function summarizeEvidenceValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    const json = JSON.stringify(value);
    return json.length > 220 ? `${json.slice(0, 217)}...` : json;
  } catch {
    return '[unserializable evidence]';
  }
}

function groupToolsByPermission(tools: ToolDescriptor[]): Record<'read' | 'plan' | 'write', ToolDescriptor[]> {
  const levelOf = (tool: ToolDescriptor): string => tool.permissionLevel ?? tool.permission;
  return {
    read: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'read' || level === 'analyze';
    }),
    plan: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'propose' || level === 'stage' || level === 'validate' || level === 'plan';
    }),
    write: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'commit' || level === 'rollback' || level === 'write';
    })
  };
}

function isResourceKindMode(mode: WorkspaceMode): mode is ResourceKind {
  return mode !== 'files' && mode !== 'ai' && mode !== 'settings';
}

function filterFilesForMode(files: IndexedFile[], mode: WorkspaceMode, query: string): IndexedFile[] {
  const normalized = query.trim().toLowerCase();
  return files.filter((file) => {
    if (isResourceKindMode(mode) && file.resourceKind !== mode) return false;
    if (!normalized) return true;
    return file.relativePath.toLowerCase().includes(normalized)
      || file.resourceKind.toLowerCase().includes(normalized)
      || file.formatLabel.toLowerCase().includes(normalized);
  });
}

function shortenPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join('/')}`;
}
