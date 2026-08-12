import { useMemo, useState, type ReactElement } from 'react';
import type { EmevdEditorDocument } from '@soulforge/shared';

export interface EventSourceSubmitResult {
  ok: boolean;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  nextDslTemplate?: string;
}

export interface EventSourceWorkbenchPanelProps {
  initialDocument: EmevdEditorDocument;
  onStructuredMutation?: (mutation: {
    kind: 'emevd_set_rest_behavior' | 'emevd_update_id';
    eventUri: string;
    restBehavior?: number;
    newEventId?: number;
    baseRevision: number;
  }) => void;
  dslTemplate?: string;
  dslTemplateTruncated?: boolean;
  dslTemplateTotalLines?: number;
  onLoadFullDslTemplate?: () => void | Promise<void>;
  onDslSubmit?: (sourceText: string) => Promise<EventSourceSubmitResult>;
}

function renderSource(document: EmevdEditorDocument): string {
  const lines = [`$Resource(Uri=${JSON.stringify(document.resourceUri)});`];
  for (const event of document.events) {
    lines.push(`$Event(Id=${event.eventId}, Rest=${event.restBehavior}, Layer=${event.layer}) {`);
    for (const instruction of event.instructions) {
      lines.push(`  instruction(Bank=${instruction.bank}, Id=${instruction.id}, Uri=${JSON.stringify(instruction.instructionUri)});`);
    }
    lines.push('}');
  }
  return lines.join('\n');
}

/** Event 的单一 source workbench：源码、outline、inspector、problems 四个语义区。 */
export function EventSourceWorkbenchPanel(props: EventSourceWorkbenchPanelProps): ReactElement {
  const [document, setDocument] = useState(props.initialDocument);
  const [selectedEventUri, setSelectedEventUri] = useState(props.initialDocument.events[0]?.eventUri ?? null);
  const [sourceEdit, setSourceEdit] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('就绪');
  const selectedEvent = document.events.find((event) => event.eventUri === selectedEventUri) ?? null;
  const generatedSource = useMemo(() => renderSource(document), [document]);
  const sourceText = sourceEdit ?? props.dslTemplate ?? generatedSource;
  const problems = document.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info');

  function toggleRestBehavior(): void {
    if (!selectedEvent) return;
    const next = selectedEvent.restBehavior === 0 ? 1 : 0;
    setDocument((current) => ({
      ...current,
      revision: current.revision + 1,
      events: current.events.map((event) => event.eventUri === selectedEvent.eventUri
        ? { ...event, restBehavior: next }
        : event)
    }));
    props.onStructuredMutation?.({
      kind: 'emevd_set_rest_behavior',
      eventUri: selectedEvent.eventUri,
      restBehavior: next,
      baseRevision: document.revision
    });
    setStatus(`已请求 restBehavior=${next}`);
  }

  async function submitSource(): Promise<void> {
    if (!props.onDslSubmit || submitting) return;
    setSubmitting(true);
    setStatus('源码提交中（compile → plan → staging）…');
    try {
      const result = await props.onDslSubmit(sourceText);
      if (result.ok) {
        setSourceEdit(result.nextDslTemplate ?? sourceText);
        setStatus('源码已通过提交管线；等待文档刷新。');
      } else {
        setStatus(result.diagnostics[0]?.message ?? '源码提交被拒绝。');
      }
    } catch (error) {
      setStatus(`源码提交异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="event-source-workbench" aria-label="Event 源码工作台">
      <header className="event-source__header">
        <div>
          <span className="event-source__eyebrow">EVENT / SOURCE</span>
          <h2>事件源码工作台</h2>
        </div>
        <span className="muted">revision {document.revision} · {status}</span>
      </header>
      <div className="event-source__grid">
        <section className="event-source__source" aria-label="事件源码">
          <div className="event-source__section-header"><strong>Source</strong><span className="muted">结构化源码投影</span></div>
          <textarea
            value={sourceText}
            onChange={(event) => setSourceEdit(event.target.value)}
            readOnly={props.dslTemplate === undefined && props.onDslSubmit === undefined}
            spellCheck={false}
            data-editor-engine="source-fallback"
            aria-label="Event 源码编辑器"
          />
          {props.dslTemplateTruncated && (
            <div className="event-source__notice">
              源码模板已按行截断，共 {props.dslTemplateTotalLines ?? 0} 行。
              <button type="button" className="secondary-action" onClick={() => void props.onLoadFullDslTemplate?.()}>
                加载完整源码
              </button>
            </div>
          )}
          <div className="event-source__source-actions">
            <button type="button" className="primary-action" disabled={!props.onDslSubmit || submitting} onClick={() => void submitSource()}>
              {submitting ? '提交中…' : '编译并提交'}
            </button>
            <span className="muted">源码编辑器只提交增量计划，renderer 不持有文件系统路径。</span>
          </div>
        </section>

        <section className="event-source__outline" aria-label="事件大纲">
          <div className="event-source__section-header"><strong>Outline</strong><span className="muted">{document.events.length} events</span></div>
          <div className="event-source__outline-list">
            {document.events.map((event) => (
              <button
                key={event.eventUri}
                type="button"
                className={event.eventUri === selectedEventUri ? 'event-source__outline-item is-selected' : 'event-source__outline-item'}
                onClick={() => setSelectedEventUri(event.eventUri)}
              >
                <strong>Event {event.eventId}</strong>
                <span>rest {event.restBehavior} · {event.instructions.length} instructions</span>
              </button>
            ))}
            {document.events.length === 0 && <p className="empty-hint">暂无事件。</p>}
          </div>
        </section>

        <section className="event-source__inspector" aria-label="事件检查器">
          <div className="event-source__section-header"><strong>Inspector</strong><span className="muted">选中节点</span></div>
          {selectedEvent ? (
            <dl className="event-source__facts">
              <div><dt>Event ID</dt><dd>{selectedEvent.eventId}</dd></div>
              <div><dt>Layer</dt><dd>{selectedEvent.layer}</dd></div>
              <div><dt>Rest behavior</dt><dd>{selectedEvent.restBehavior}</dd></div>
              <div><dt>Instructions</dt><dd>{selectedEvent.instructions.length}</dd></div>
              <div><dt>URI</dt><dd title={selectedEvent.eventUri}>{selectedEvent.eventUri}</dd></div>
            </dl>
          ) : <p className="empty-hint">从 Outline 选择一个事件。</p>}
          <button type="button" className="secondary-action" disabled={!selectedEvent} onClick={toggleRestBehavior}>
            切换 restBehavior
          </button>
        </section>

        <section className="event-source__problems" aria-label="事件问题">
          <div className="event-source__section-header"><strong>Problems</strong><span className={problems.length > 0 ? 'pill pill--warn' : 'pill'}>{problems.length}</span></div>
          {problems.length === 0
            ? <p className="empty-hint">当前没有结构化问题。</p>
            : problems.map((problem) => <div className="event-source__problem" key={`${problem.code}:${problem.message}`}><strong>{problem.code}</strong><span>{problem.message}</span></div>)}
        </section>
      </div>
    </section>
  );
}
