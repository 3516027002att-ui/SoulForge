import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import type {
  Diagnostic,
  RendererContainerChild,
  RendererContainerTreeSummary
} from '@soulforge/shared';
import { HexEditorPanel } from './HexEditorPanel.js';
import { isLikelyBase64, uint8ArrayToBase64 } from '../utils/binary.js';

export interface Bnd4WorkbenchPanelProps {
  resourceUri: string;
  onMutationCommitted?: () => void | Promise<void>;
}

interface ReplaceResultView {
  ok: boolean;
  message: string;
  diagnostics: Diagnostic[];
}

/**
 * BND4 容器工作台：只读条目树 + 子项 Hex 证据 + 用户提供字节的整个
 * 子项替换。不提供 typed mutation（bnd4 contract mutationKinds=[]）；
 * 替换字节必须由用户提供，SoulForge 不生成内容。
 */
export function Bnd4WorkbenchPanel(props: Bnd4WorkbenchPanelProps): ReactElement {
  const [root, setRoot] = useState<RendererContainerTreeSummary | null>(null);
  const [children, setChildren] = useState<RendererContainerChild[]>([]);
  const [listDiagnostics, setListDiagnostics] = useState<Diagnostic[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedChildUri, setSelectedChildUri] = useState<string | null>(null);
  const [childHexBase64, setChildHexBase64] = useState<string | null>(null);
  const [childHash, setChildHash] = useState<string | null>(null);
  const [childReadDiagnostics, setChildReadDiagnostics] = useState<Diagnostic[]>([]);
  const [loadingChild, setLoadingChild] = useState(false);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceBytes, setReplaceBytes] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [replaceResult, setReplaceResult] = useState<ReplaceResultView | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!props.resourceUri) {
      setRoot(null);
      setChildren([]);
      setListDiagnostics([]);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [tree, list] = await Promise.all([
        window.soulforge.inspectContainerTree(props.resourceUri),
        window.soulforge.listContainerChildren(props.resourceUri)
      ]);
      setRoot(tree);
      setChildren(list.children);
      setListDiagnostics([...(tree.diagnostics ?? []), ...(list.diagnostics ?? [])]);
      if (!tree.ok && list.children.length === 0) {
        setLoadError(tree.diagnostics?.[0]?.message ?? '容器读取失败。');
      }
    } catch (error) {
      setRoot(null);
      setChildren([]);
      setLoadError(error instanceof Error ? error.message : '容器读取异常。');
    } finally {
      setLoading(false);
    }
  }, [props.resourceUri]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedChild = useMemo(
    () => children.find((child) => child.childUri === selectedChildUri) ?? null,
    [children, selectedChildUri]
  );

  async function selectChild(child: RendererContainerChild): Promise<void> {
    setSelectedChildUri(child.childUri);
    setChildHexBase64(null);
    setChildHash(null);
    setChildReadDiagnostics([]);
    setReplaceOpen(false);
    setReplaceBytes('');
    setReplaceResult(null);
    setLoadingChild(true);
    try {
      const read = await window.soulforge.readContainerChild(child.childUri);
      if (read.ok && read.bytes) {
        setChildHexBase64(uint8ArrayToBase64(read.bytes));
        setChildHash(read.hash ?? null);
        setChildReadDiagnostics([]);
      } else {
        setChildHexBase64(null);
        setChildHash(null);
        setChildReadDiagnostics(read.diagnostics ?? []);
      }
    } catch (error) {
      setChildHexBase64(null);
      setChildHash(null);
      setChildReadDiagnostics([{
        severity: 'error',
        code: 'CHILD_READ_EXCEPTION',
        message: error instanceof Error ? error.message : '读取子项失败。'
      }]);
    } finally {
      setLoadingChild(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      setReplaceBytes(comma >= 0 ? dataUrl.slice(comma + 1) : '');
      setReplaceResult(null);
    };
    reader.readAsDataURL(file);
  }

  async function submitReplace(): Promise<void> {
    if (!selectedChild || !root?.root) return;
    const base64 = replaceBytes.trim();
    if (!isLikelyBase64(base64)) {
      setReplaceResult({
        ok: false,
        message: '请提供有效的 base64 字节（替换字节必须由用户提供）。',
        diagnostics: []
      });
      return;
    }
    const containerHash = root.root.hash;
    const expectedChildHash = selectedChild.hash;
    setReplacing(true);
    setReplaceResult(null);
    try {
      const result = await window.soulforge.replaceContainerChild(
        selectedChild.childUri,
        containerHash,
        expectedChildHash,
        base64
      );
      const ok = Boolean(result.ok);
      setReplaceResult({
        ok,
        message: ok
          ? '子项已替换并提交（Patch Engine 事务 + 已建立可回滚备份）。'
          : (result.diagnostics?.[0]?.message ?? '子项替换失败。'),
        diagnostics: result.diagnostics ?? []
      });
      if (ok) {
        setReplaceOpen(false);
        setReplaceBytes('');
        await load();
        await props.onMutationCommitted?.();
      }
    } catch (error) {
      setReplaceResult({
        ok: false,
        message: error instanceof Error ? error.message : '子项替换调用异常。',
        diagnostics: []
      });
    } finally {
      setReplacing(false);
    }
  }

  const canReplace = Boolean(root?.root?.canReplaceChild);

  return (
    <section className="panel" aria-label="BND4 容器工作台">
      <header className="panel-header">
        <h3>BND4 容器工作台</h3>
        <span className="muted">{children.length} 个子项</span>
      </header>

      {loading && <p className="muted">正在读取容器…</p>}
      {loadError && <p className="danger">{loadError}</p>}
      {!loading && !loadError && !root && <p className="muted">选择左侧容器资源后显示工作台。</p>}

      {root?.root && (
        <>
          <div className="structured-preview-grid">
            <span>格式：{root.root.format}</span>
            <span>authority：{root.root.authority}</span>
            <span>大小：{root.root.size} 字节</span>
            <span>magic：{root.root.magic || '—'}</span>
            <span>容器校验：{shortHash(root.root.hash)}</span>
            <span>round-trip 安全：{root.root.containerRoundTripSafe ? '是' : '否'}</span>
            <span>可列出子项：{root.root.canListChildren ? '是' : '否'}</span>
            <span>可替换子项：{root.root.canReplaceChild ? '是' : '否'}</span>
          </div>
          {!root.root.canListChildren && (
            <p className="muted">
              该容器未提供子项列表（原生 BND 未带 SFBN 标记，或为不支持解压的 DCX）；只读证据层级不可用。
            </p>
          )}
        </>
      )}

      <div className="binder-child-table script-entry-table" role="table">
        <div className="binder-child-row binder-child-header script-entry-row" role="row">
          <span>名称</span>
          <span>ID</span>
          <span>类型</span>
          <span>偏移</span>
          <span>大小</span>
          <span>嵌套</span>
          <span>替换</span>
        </div>
        {children.map((child) => (
          <div
            key={child.childUri}
            className={child.childUri === selectedChildUri
              ? 'binder-child-row bnd4-child-row selected'
              : 'binder-child-row bnd4-child-row'}
            role="row"
            onClick={() => void selectChild(child)}
          >
            <span title={child.name ?? ''}>{child.name ?? '（无名称）'}</span>
            <span className="muted">{child.childId}</span>
            <span className="muted">{child.formatKind}</span>
            <span className="muted">0x{child.offset.toString(16)}</span>
            <span>{child.size}{child.compressedSize !== undefined && child.compressedSize !== child.size
              ? ` / ${child.compressedSize}`
              : ''}</span>
            <span className="muted">{child.nestedFormat ?? '—'}</span>
            <span>{child.canReplace ? '可' : '只读'}</span>
          </div>
        ))}
        {children.length === 0 && !loading && <p className="muted">无子项列表。</p>}
      </div>

      {listDiagnostics.length > 0 && (
        <div className="save-diagnostics">
          {listDiagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.message}`}>
              {diagnostic.code}: {diagnostic.message}
            </span>
          ))}
        </div>
      )}

      {loadingChild && <p className="muted">正在读取子项字节…</p>}
      {childHexBase64 && (
        <>
          <HexEditorPanel
            title={`${selectedChild?.name ?? '子项'} 只读 Hex 证据${childHash ? ` · ${shortHash(childHash)}` : ''}`}
            initialBytesBase64={childHexBase64}
          />
          <p className="muted">子项字节为只读证据视图；替换须由用户提供字节，SoulForge 不生成内容。</p>
          <div className="row gap">
            <button
              type="button"
              disabled={!canReplace || !selectedChild?.canReplace}
              onClick={() => {
                setReplaceOpen((current) => !current);
                setReplaceResult(null);
              }}
            >
              {replaceOpen ? '收起替换表单' : '替换子项（用户提供字节）'}
            </button>
            {!canReplace && <span className="muted">当前容器不支持权威子项替换。</span>}
          </div>
        </>
      )}

      {childReadDiagnostics.length > 0 && (
        <div className="save-diagnostics">
          {childReadDiagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.message}`}>
              {diagnostic.code}: {diagnostic.message}
            </span>
          ))}
        </div>
      )}

      {replaceOpen && selectedChild && (
        <div className="stack gap">
          <p className="muted">
            替换目标：{selectedChild.name ?? selectedChild.childId}
            {childHash ? ` · 条目校验 ${shortHash(childHash)}` : ''}
            {root?.root ? ` · 容器校验 ${shortHash(root.root.hash)}` : ''}
          </p>
          <label className="stack gap">
            选择替换字节文件（由你提供）
            <input type="file" onChange={handleFileChange} />
          </label>
          <label className="stack gap">
            或粘贴 base64 字节
            <textarea
              value={replaceBytes}
              onChange={(event) => {
                setReplaceBytes(event.target.value);
                setReplaceResult(null);
              }}
              rows={3}
              spellCheck={false}
              placeholder="dataBase64…"
            />
          </label>
          <div className="row gap">
            <button
              type="button"
              disabled={replacing || replaceBytes.trim().length === 0}
              onClick={() => void submitReplace()}
            >
              {replacing ? '提交中…' : '经 Patch Engine 替换并提交'}
            </button>
            <button type="button" disabled={replacing} onClick={() => setReplaceOpen(false)}>
              取消
            </button>
          </div>
          {replaceResult && (
            <p className={replaceResult.ok ? undefined : 'danger'}>{replaceResult.message}</p>
          )}
          {replaceResult && replaceResult.diagnostics.length > 0 && (
            <div className="save-diagnostics">
              {replaceResult.diagnostics.map((diagnostic) => (
                <span key={`${diagnostic.code}-${diagnostic.message}`}>
                  {diagnostic.code}: {diagnostic.message}
                </span>
              ))}
            </div>
          )}
          <p className="muted">整个子项替换会经 Patch Engine 事务并弹出主进程确认对话框；不提供 typed mutation。</p>
        </div>
      )}
    </section>
  );
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}
