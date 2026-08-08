import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

/** 单次按偏移读取的字节数。与 core 的 16 MiB 单次上限相比极小——hex 视图一次只
 *  渲染一屏，拉大页宽只会让 DOM 变重而用户看不到更多。 */
const RANGE_WINDOW = 4096;
/** 每行显示的字节数。 */
const ROW_BYTES = 16;

export interface HexEditorPanelProps {
  title: string;
  initialBytesBase64: string;
  /**
   * 资源总字节数。**必须是文件真实大小，不是已加载前缀的长度**——
   * 此前面板把 `bytes.length` 当总量显示，对 168 MB 的文件会说「65536 字节」，
   * 用户据此以为整个文件就这么大。实测 mods 下 237 个文件有 148 个超过 64KB 的
   * 预览上限，所以这不是边缘情况。
   */
  totalBytes?: number;
  /**
   * 按偏移读取更多字节。接 IPC 的 `readRawRange`（main handler 在 ipc.ts:1170，
   * core 实现 files/rawRead.ts:100，带 offset/length 校验与 16 MiB 单次上限）。
   *
   * 可选：容器子项字节（Bnd4WorkbenchPanel 的调用点）没有独立 sourceUri，
   * 无法按偏移回读，此时不传即退化为「只看已加载前缀」并如实标注。
   * 硬约束 17 要求大规模访问必须分页——传了它才真正满足。
   */
  onLoadRange?: (offset: number, length: number) => Promise<{
    ok: boolean;
    /**
     * 窗口字节的 base64。**字段名必须与 core 的 RawResourceRangeResult 一致**
     * （packages/core/src/files/rawRead.ts:35 叫 `base64`）——我第一版这里写成
     * `bytesBase64`，于是永远读不到数据、翻页静默停在原窗口，而 typecheck 抓不到，
     * 因为调用侧对 IPC 返回值用了 as 断言。IPC 边界上类型是断言出来的而非检查出来
     * 的，字段名对不上只会表现为「功能不工作」，不会有编译错误。
     */
    base64?: string;
    fileSize?: number;
    diagnostics?: Array<{ code: string; message: string }>;
  }>;
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
 *
 * 两种模式：
 *  · 传了 onLoadRange —— 按偏移向 main 请求 4 KiB 窗口，可覆盖整个文件（硬约束 17）
 *  · 未传 —— 只能翻已加载的前缀，界面如实标注「仅前缀」，不假装能看全文
 */
export function HexEditorPanel(props: HexEditorPanelProps): ReactElement {
  const prefixBytes = useMemo(
    () => decodeBase64(props.initialBytesBase64),
    [props.initialBytesBase64]
  );

  // 窗口内容与它的起始偏移。未接 onLoadRange 时窗口恒等于前缀。
  const [windowBytes, setWindowBytes] = useState<Uint8Array>(prefixBytes);
  const [windowOffset, setWindowOffset] = useState(0);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // main 报的真实文件大小优先于 props（readRawRange 的返回值带 fileSize）。
  const [reportedSize, setReportedSize] = useState<number | undefined>(undefined);

  useEffect(() => {
    setWindowBytes(prefixBytes);
    setWindowOffset(0);
    setRangeError(null);
    setReportedSize(undefined);
  }, [prefixBytes]);

  const canSeek = props.onLoadRange !== undefined;
  const totalBytes = reportedSize ?? props.totalBytes ?? prefixBytes.length;
  // 未接 range 通道时能翻的上限就是前缀长度——不得按 totalBytes 算页数，
  // 否则会渲染出点不动的翻页按钮（那正是 T1-5 修过的降级路径缺陷）。
  const reachableBytes = canSeek ? totalBytes : prefixBytes.length;
  const rowsPerWindow = Math.max(1, Math.ceil(windowBytes.length / ROW_BYTES));

  const seek = useCallback(async (nextOffset: number): Promise<void> => {
    const clamped = Math.max(0, Math.min(nextOffset, Math.max(0, reachableBytes - 1)));
    if (!props.onLoadRange) {
      // 前缀内滑动：直接切片，不发 IPC。
      setWindowOffset(clamped);
      setWindowBytes(prefixBytes.subarray(clamped, Math.min(clamped + RANGE_WINDOW, prefixBytes.length)));
      return;
    }
    setLoading(true);
    setRangeError(null);
    try {
      const result = await props.onLoadRange(clamped, RANGE_WINDOW);
      if (!result.ok) {
        const first = result.diagnostics?.[0];
        // 失败必须可见且带诊断码——静默停在旧窗口会让用户以为翻页成功了。
        setRangeError(first ? `${first.code}：${first.message}` : '按偏移读取失败（未返回诊断）');
        return;
      }
      if (typeof result.fileSize === 'number' && result.fileSize > 0) setReportedSize(result.fileSize);
      if (typeof result.base64 === 'string') {
        setWindowBytes(decodeBase64(result.base64));
        setWindowOffset(clamped);
      }
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : '按偏移读取抛出未知错误');
    } finally {
      setLoading(false);
    }
  }, [props, prefixBytes, reachableBytes]);

  const atStart = windowOffset <= 0;
  const atEnd = windowOffset + windowBytes.length >= reachableBytes;

  return (
    <section className="panel editor-hex" aria-label="只读 Hex 证据视图">
      <header className="panel-header">
        <h3>只读 Hex 证据：{props.title}</h3>
        <span className="muted">
          偏移 0x{windowOffset.toString(16).toUpperCase()} · 本窗口 {windowBytes.length} 字节
          {totalBytes > 0 && ` · 共 ${totalBytes} 字节`}
          {rowsPerWindow > 0 && ` · ${rowsPerWindow} 行`}
        </span>
      </header>
      <pre className="hex-view">{toHex(windowBytes) || '（空窗口）'}</pre>
      <div className="row gap">
        <button
          type="button"
          disabled={atStart || loading}
          onClick={() => void seek(Math.max(0, windowOffset - RANGE_WINDOW))}
        >
          上一段
        </button>
        <button
          type="button"
          disabled={atEnd || loading}
          onClick={() => void seek(windowOffset + windowBytes.length)}
        >
          下一段
        </button>
        {loading && <span className="muted">读取中…</span>}
      </div>
      {rangeError !== null && <p className="diag-error">{rangeError}</p>}
      {!canSeek && totalBytes > prefixBytes.length && (
        <p className="muted">
          本视图未接按偏移读取通道，只能翻已加载的前 {prefixBytes.length} 字节
          （共 {totalBytes} 字节）。未加载部分无法在此查看。
        </p>
      )}
      <p className="muted">仅显示偏移和原始字节；不能从此视图创建或提交 mutation。</p>
    </section>
  );
}
