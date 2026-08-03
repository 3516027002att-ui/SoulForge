import { useEffect, useMemo, useState, type ReactElement } from 'react';

export interface HexEditorPanelProps {
  title: string;
  initialBytesBase64: string;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Renderer-safe, read-only Hex evidence panel (no Node Buffer/crypto).
 */
export function HexEditorPanel(props: HexEditorPanelProps): ReactElement {
  const pageSize = 16;
  const bytes = useMemo(
    () => decodeBase64(props.initialBytesBase64),
    [props.initialBytesBase64]
  );
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(bytes.length / pageSize));
  useEffect(() => {
    setPage(0);
  }, [props.initialBytesBase64]);
  const offset = page * pageSize;
  const pageBytes = useMemo(
    () => bytes.subarray(offset, Math.min(offset + pageSize, bytes.length)),
    [bytes, offset]
  );

  return (
    <section className="panel editor-hex" aria-label="只读 Hex 证据视图">
      <header className="panel-header">
        <h3>只读 Hex 证据：{props.title}</h3>
        <span className="muted">{bytes.length} 字节 · 第 {page + 1}/{pageCount} 页</span>
      </header>
      <pre className="hex-view">{toHex(pageBytes) || '（空页）'}</pre>
      <div className="row gap">
        <button type="button" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
        >
          下一页
        </button>
      </div>
      <p className="muted">仅显示偏移和原始字节；不能从此视图创建或提交 mutation。</p>
    </section>
  );
}
