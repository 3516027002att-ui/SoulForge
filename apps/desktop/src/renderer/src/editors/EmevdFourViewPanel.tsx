import { useMemo, useState, type ReactElement } from 'react';
import type { EmevdEditorDocument, EmevdSelection, EmevdViewId } from '@soulforge/shared';

export interface EmevdDslSubmitResult {
  ok: boolean;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  nextDslTemplate?: string;
}

export interface EmevdFourViewPanelProps {
  /** Pre-built structural document from main/Bridge (no Node in renderer). */
  initialDocument: EmevdEditorDocument;
  onStructuredMutation?: (mutation: {
    kind: 'emevd_set_rest_behavior' | 'emevd_update_id';
    eventUri: string;
    restBehavior?: number;
    newEventId?: number;
    baseRevision: number;
  }) => void;
  /**
   * Patch-DSL template rendered from the authoritative full document held in
   * main. When provided, the DSL view becomes editable and can be submitted
   * through onDslSubmit; the renderer never holds the full document.
   */
  dslTemplate?: string;
  onDslSubmit?: (sourceText: string) => Promise<EmevdDslSubmitResult>;
}

function renderDsl(document: EmevdEditorDocument): string {
  const lines = [`$Resource(Uri=${JSON.stringify(document.resourceUri)});`];
  for (const event of document.events) {
    lines.push(
      `$Event(Id=${event.eventId}, Uri=${JSON.stringify(event.eventUri)}, Rest=${event.restBehavior}, Layer=${event.layer}) {`
    );
    for (const instr of event.instructions) {
      lines.push(
        `  unknown(Uri=${JSON.stringify(instr.instructionUri)}, Bank=${instr.bank}, Id=${instr.id}, ArgsBase64=${JSON.stringify(instr.argsBase64)});`
      );
    }
    lines.push('}');
  }
  return lines.join('\n');
}

/**
 * EMEVD 四视图：流程列表 / 指令表 / DSL / 只读字节。
 * 共享 revision + selection；DSL 不可作为 mutation 权威来源。
 */
export function EmevdFourViewPanel(props: EmevdFourViewPanelProps): ReactElement {
  const [document, setDocument] = useState(props.initialDocument);
  const [selection, setSelection] = useState<EmevdSelection>(() => {
    const first = props.initialDocument.events[0]?.eventUri;
    return first ? { view: 'flow', eventUri: first } : { view: 'flow' };
  });
  const [status, setStatus] = useState('就绪');
  const [dslEdit, setDslEdit] = useState<string | null>(null);
  const [submittingDsl, setSubmittingDsl] = useState(false);

  const dslText = useMemo(() => renderDsl(document), [document]);
  const dslDisplay = dslEdit ?? props.dslTemplate ?? dslText;
  const selectedEvent = document.events.find((event) => event.eventUri === selection.eventUri);
  const hexPreview = useMemo(() => {
    try {
      const binary = atob(document.bytesBase64 || '');
      const bytes = new Uint8Array(Math.min(binary.length, 64));
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    } catch {
      return '（无字节预览）';
    }
  }, [document.bytesBase64]);

  function selectView(view: EmevdViewId): void {
    setSelection((prev) => ({ ...prev, view }));
  }

  function selectEvent(eventUri: string): void {
    setSelection((prev) => ({ ...prev, eventUri, view: prev.view === 'bytes' ? 'bytes' : prev.view }));
  }

  function flipRestBehavior(): void {
    if (!selectedEvent) return;
    const next = selectedEvent.restBehavior === 0 ? 1 : 0;
    // Local optimistic structural update for UI sync; parent commits via PatchIR/Bridge.
    setDocument((doc) => ({
      ...doc,
      revision: doc.revision + 1,
      events: doc.events.map((event) => (
        event.eventUri === selectedEvent.eventUri
          ? { ...event, restBehavior: next }
          : event
      ))
    }));
    props.onStructuredMutation?.({
      kind: 'emevd_set_rest_behavior',
      eventUri: selectedEvent.eventUri,
      restBehavior: next,
      baseRevision: document.revision
    });
    setStatus(`已请求 restBehavior=${next}（revision→${document.revision + 1}）`);
  }

  function noteDslEdit(): void {
    setStatus('DSL 仅供显示；解析错误不会写入文档。请用事件表/属性面板产生 mutation。');
  }

  async function submitDsl(): Promise<void> {
    if (!props.onDslSubmit || submittingDsl) return;
    setSubmittingDsl(true);
    setStatus('DSL 提交中（compile → plan → Bridge staging → PatchIR transaction）…');
    try {
      const result = await props.onDslSubmit(dslDisplay);
      if (result.ok) {
        setDslEdit(result.nextDslTemplate ?? dslDisplay);
        setStatus(`DSL 已提交${result.nextDslTemplate ? '；模板已刷新' : ''}。`);
      } else {
        const first = result.diagnostics[0];
        setStatus(first ? `${first.code}: ${first.message}` : 'DSL 提交被拒绝。');
      }
    } catch (error) {
      setStatus(`DSL 提交异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmittingDsl(false);
    }
  }

  return (
    <section className="panel emevd-four-view" aria-label="EMEVD 四视图">
      <header className="panel-header">
        <h3>EMEVD 四视图</h3>
        <span className="muted">revision {document.revision}</span>
      </header>
      <div className="row gap">
        {(['flow', 'table', 'dsl', 'bytes'] as EmevdViewId[]).map((view) => (
          <button
            key={view}
            type="button"
            className={selection.view === view ? 'primary-action' : 'secondary-action'}
            onClick={() => selectView(view)}
          >
            {view === 'flow' ? '流程' : view === 'table' ? '指令表' : view === 'dsl' ? 'DSL' : '原始字节'}
          </button>
        ))}
      </div>

      {selection.view === 'flow' && (
        <ul className="list">
          {document.events.map((event) => (
            <li key={event.eventUri}>
              <button type="button" onClick={() => selectEvent(event.eventUri)}>
                事件 {event.eventId} · rest={event.restBehavior} · {event.instructions.length} 指令
              </button>
            </li>
          ))}
        </ul>
      )}

      {selection.view === 'table' && (
        <div className="binder-child-table" role="table">
          <div className="binder-child-row binder-child-header" role="row">
            <span>Event</span>
            <span>Rest</span>
            <span>Instructions</span>
            <span>URI</span>
          </div>
          {document.events.map((event) => (
            <div
              key={event.eventUri}
              className="binder-child-row"
              role="row"
              onClick={() => selectEvent(event.eventUri)}
            >
              <span>{event.eventId}</span>
              <span>{event.restBehavior}</span>
              <span>{event.instructions.length}</span>
              <span title={event.eventUri}>{event.eventUri.slice(-24)}</span>
            </div>
          ))}
        </div>
      )}

      {selection.view === 'dsl' && (
        <div className="column gap">
          <textarea
            className="hex-view"
            value={dslDisplay}
            readOnly={props.dslTemplate === undefined}
            onChange={(e) => {
              setDslEdit(e.target.value);
              noteDslEdit();
            }}
            spellCheck={false}
            aria-label={props.dslTemplate === undefined
              ? 'EMEVD DSL 只读权威外视图（未连接完整文档）'
              : 'EMEVD patch DSL 编辑区'}
          />
          {props.dslTemplate !== undefined && (
            <div className="row gap">
              <button
                type="button"
                className="primary-action"
                disabled={submittingDsl}
                onClick={() => void submitDsl()}
              >
                {submittingDsl ? '提交中…' : '编译并提交 DSL'}
              </button>
              <button
                type="button"
                disabled={submittingDsl}
                onClick={() => {
                  setDslEdit(null);
                  setStatus('已放弃编辑，恢复模板。');
                }}
              >
                放弃编辑
              </button>
              <span className="muted">编辑会经主进程完整文档编译；渲染进程不持有完整文档。</span>
            </div>
          )}
        </div>
      )}

      {selection.view === 'bytes' && (
        <pre className="hex-view" aria-label="EMEVD 原始字节只读">
          {hexPreview}
          {'\n'}
          （只读；字节修改请切换 Hex 工作台）
        </pre>
      )}

      <div className="row gap">
        <button type="button" disabled={!selectedEvent} onClick={flipRestBehavior}>
          切换选中事件 restBehavior
        </button>
        <span className="muted">
          选中：{selectedEvent ? `event ${selectedEvent.eventId}` : '无'}
        </span>
      </div>
      <p className="muted">{status}</p>
      {document.diagnostics.map((d) => (
        <p key={`${d.code}-${d.message}`} className="muted">{d.code}: {d.message}</p>
      ))}
    </section>
  );
}
