import { useMemo, useState, type ReactElement } from 'react';
import type { IndexedFile, ResourceKind, ResourcePreview, WorkspaceScanResult } from '@soulforge/shared';
import type { AnalyzeWorkspaceSummary } from '../../main/ipc.js';
import type { ToolDescriptor, ToolResult } from '@soulforge/core';

const RESOURCE_KIND_ORDER: ResourceKind[] = ['event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'sfx', 'unknown'];

export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceScanResult | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeWorkspaceSummary | null>(null);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [selectedFile, setSelectedFile] = useState<IndexedFile | null>(null);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [query, setQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [eventUri, setEventUri] = useState('');
  const [toolOutput, setToolOutput] = useState<ToolResult | null>(null);
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [status, setStatus] = useState('就绪');

  const counts = useMemo(() => workspace?.countsByKind ?? null, [workspace]);
  const diagnostics = [...(workspace?.diagnostics ?? []), ...(analysis?.diagnostics ?? []), ...(preview?.diagnostics ?? [])];

  async function openWorkspace(): Promise<void> {
    const workspaceRoot = await window.soulforge.openWorkspaceDialog();
    if (!workspaceRoot) return;

    setStatus('正在扫描工作区...');
    const result = await window.soulforge.scanWorkspace(workspaceRoot);
    setWorkspace(result);
    setFiles(result.files.slice(0, 300));
    setSelectedFile(null);
    setPreview(null);
    setAnalysis(null);
    setToolOutput(null);

    setStatus('正在构建轻量证据索引...');
    const nextAnalysis = await window.soulforge.analyzeWorkspace(workspaceRoot);
    setAnalysis(nextAnalysis);
    setTools(nextAnalysis.tools);
    setEventUri(nextAnalysis.events[0]?.uri ?? '');
    setStatus(`已索引 ${result.files.length} 个文件，解析 ${nextAnalysis.parsedFiles} 个文本/mock 资源`);
  }

  async function search(): Promise<void> {
    const result = await window.soulforge.searchResources(query);
    setFiles(result);
    setStatus(`搜索返回 ${result.length} 个文件`);
  }

  async function selectFile(file: IndexedFile): Promise<void> {
    setSelectedFile(file);
    setPreview(null);
    setStatus(`正在打开 ${file.relativePath}...`);
    const nextPreview = await window.soulforge.openResourcePreview(file.sourceUri);
    setPreview(nextPreview);
    setStatus(nextPreview ? `已打开 ${file.relativePath}` : '无法预览该资源');
  }

  async function runToolSearch(): Promise<void> {
    const result = await window.soulforge.runAiTool('search_resources', { query: toolQuery, limit: 8 }, 'plan');
    setToolOutput(result);
  }

  async function explainEvent(): Promise<void> {
    const result = await window.soulforge.runAiTool('explain_event', { uri: eventUri }, 'plan');
    setToolOutput(result);
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <section>
          <h1>SoulForge</h1>
          <p>Super Event Editor v0.1 | Stop modding in the dark.</p>
        </section>
        <button type="button" onClick={openWorkspace}>打开 Mod 工作区</button>
      </header>

      <nav className="mode-tabs" aria-label="editor modes">
        <span className="active">Events</span>
        <span>Params</span>
        <span>Text</span>
        <span>Maps</span>
        <span>Files</span>
        <span>AI</span>
        <span>Settings</span>
      </nav>

      <section className="workspace-summary">
        <strong>Workspace:</strong> {workspace?.workspaceRoot ?? '未打开'}
        {counts && (
          <div className="counts">
            {RESOURCE_KIND_ORDER.map((kind) => (
              <span key={kind}>{kind}: {counts[kind]}</span>
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
            {files.map((file) => (
              <button
                type="button"
                key={file.sourceUri}
                className={selectedFile?.sourceUri === file.sourceUri ? 'file-item selected' : 'file-item'}
                onClick={() => void selectFile(file)}
              >
                <span>{file.relativePath}</span>
                <small>{file.resourceKind} | {(file.size / 1024).toFixed(1)} KB</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="viewer-pane">
          <h2>{selectedFile?.relativePath ?? '资源预览'}</h2>
          {!selectedFile && <p className="muted">选择左侧资源后显示限量文本或十六进制预览。</p>}
          {preview?.previewKind === 'text' && <pre>{preview.text}</pre>}
          {preview?.previewKind === 'hex' && <pre>{preview.hex}</pre>}
          {preview?.previewKind === 'empty' && <p className="muted">空文件。</p>}
          {preview?.previewKind === 'failed' && <p className="danger">预览失败。</p>}
          {preview?.truncated && <p className="muted">预览已截断，避免一次性加载大文件。</p>}
        </section>

        <aside className="ai-pane">
          <h2>AI 工具台</h2>
          <label>
            Provider
            <select defaultValue="mock">
              <option value="mock">Mock / Tool Console</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            Thinking
            <select defaultValue="normal">
              <option value="fast">fast</option>
              <option value="normal">normal</option>
              <option value="deep">deep</option>
              <option value="extreme">extreme</option>
            </select>
          </label>
          <label>
            Mode
            <select defaultValue="plan">
              <option value="plan">plan</option>
              <option value="normal">normal</option>
              <option value="fullPermission">full permission</option>
            </select>
          </label>

          <div className="context-card">
            <strong>Current context</strong>
            <span>{selectedFile?.sourceUri ?? 'No resource selected'}</span>
          </div>

          <div className="tool-panel">
            <strong>Safe tools</strong>
            <div className="tool-list">
              {(tools.length > 0 ? tools : []).map((tool) => (
                <span key={tool.name} title={tool.description}>{tool.name}</span>
              ))}
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
              <span>refs: H{analysis.referenceStats.high} / M{analysis.referenceStats.medium} / L{analysis.referenceStats.low}</span>
            </div>
          )}

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
