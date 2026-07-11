import { useMemo, useState, type ReactElement } from 'react';

export interface HexEditorPanelProps {
  title: string;
  initialBytesBase64: string;
  onPatch?: (patch: {
    offset: number;
    oldBytesBase64: string;
    newBytesBase64: string;
  }) => void;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Renderer-safe Hex panel (no Node Buffer/crypto).
 * Parent maps emitted patches into main/PatchIR.
 */
export function HexEditorPanel(props: HexEditorPanelProps): ReactElement {
  const pageSize = 16;
  const [bytes, setBytes] = useState(() => decodeBase64(props.initialBytesBase64));
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('就绪');
  const pageCount = Math.max(1, Math.ceil(bytes.length / pageSize));
  const offset = page * pageSize;
  const pageBytes = useMemo(
    () => bytes.subarray(offset, Math.min(offset + pageSize, bytes.length)),
    [bytes, offset]
  );

  function patchFirstByte(): void {
    if (pageBytes.length === 0) return;
    const oldByte = pageBytes.subarray(0, 1);
    const next = new Uint8Array(oldByte);
    next[0] = ((next[0] ?? 0) ^ 0xff) & 0xff;
    const updated = new Uint8Array(bytes);
    updated[offset] = next[0]!;
    setBytes(updated);
    setStatus(`已应用补丁 offset=${offset}`);
    props.onPatch?.({
      offset,
      oldBytesBase64: encodeBase64(oldByte),
      newBytesBase64: encodeBase64(next)
    });
  }

  return (
    <section className="panel editor-hex" aria-label="Hex 编辑器">
      <header className="panel-header">
        <h3>安全 Hex：{props.title}</h3>
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
        <button type="button" onClick={patchFirstByte}>翻转本页首字节（演示 mutation）</button>
      </div>
      <p className="muted">{status}</p>
    </section>
  );
}
