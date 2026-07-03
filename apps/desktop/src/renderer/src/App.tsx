import { useMemo, useState } from 'react';
import type { IndexedFile, ResourceKind, ResourcePreview, WorkspaceScanResult } from '@soulforge/shared';

const RESOURCE_KIND_ORDER: ResourceKind[] = ['event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'sfx', 'unknown'];

export function App(): JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceScanResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<IndexedFile | null>(null);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [status, setStatus] = useState('Ready.');

  const counts = useMemo(() => workspace?.countsByKind ?? null, [workspace]);

  async function openWorkspace(): Promise<void> {
    const workspaceRoot = await window.soulforge.openWorkspaceDialog();
    if (!workspaceRoot) return;

    setStatus('Scanning workspace...');
    const result = await window.soulforge.scanWorkspace(workspaceRoot);
    setWorkspace(result);
    setFiles(result.files.slice(0, 300));
    setSelectedFile(null);
    setPreview(null);
    setStatus(`Indexed ${result.files.length} files.`);
  }

  async function search(): Promise<void> {
    const result = await window.soulforge.searchResources(query);
    setFiles(result);
    setStatus(`Search returned ${result.length} files.`);
  }

  async function selectFile(file: IndexedFile): Promise<void> {
    setSelectedFile(file);
    setPreview(null);
    setStatus(`Opening ${file.relativePath}...`);
    const nextPreview = await window.soulforge.openResourcePreview(file.sourceUri);
    setPreview(nextPreview);
    setStatus(nextPreview ? `Opened ${file.relativePath}.` : 'Preview unavailable.');
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <section>
          <h1>SoulForge</h1>
          <p>Super Event Editor v0.1 · Stop modding in the dark.</p>
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
                <small>{file.resourceKind} · {(file.size / 1024).toFixed(1)} KB</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="viewer-pane">
          <h2>{selectedFile?.relativePath ?? '资源预览'}</h2>
          {!selectedFile && <p className="muted">打开一个工作区，然后选择文件。v0.1 先做轻量扫描和安全预览。</p>}
          {preview?.previewKind === 'text' && <pre>{preview.text}</pre>}
          {preview?.previewKind === 'hex' && <pre>{preview.hex}</pre>}
          {preview?.previewKind === 'empty' && <p className="muted">空文件。</p>}
          {preview?.previewKind === 'failed' && <p className="danger">预览失败。</p>}
          {preview?.truncated && <p className="muted">预览已截断，避免一次性加载大文件。</p>}
        </section>

        <aside className="ai-pane">
          <h2>AI Sidebar</h2>
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
          <p className="muted">v0.1 先保留 AI 原生界面和工具位置，不默认消耗模型/API 资源。</p>
          <div className="context-card">
            <strong>Current context</strong>
            <span>{selectedFile?.sourceUri ?? 'No resource selected'}</span>
          </div>
        </aside>
      </section>

      <footer className="status-bar">
        <span>{status}</span>
        <span>{preview?.diagnostics.length ? `${preview.diagnostics.length} diagnostics` : 'No diagnostics'}</span>
      </footer>
    </main>
  );
}
