/**
 * 资源预览卡片组：结构化预览、编辑能力条、容器读取摘要、Binder 子项表、
 * 原生检查卡片。
 *
 * 从 App.tsx 尾部原样搬出（纯搬移，无逻辑改动）。搬出的理由不是行数，而是这些
 * 组件与 App 的编排状态**零耦合**——它们只接 props、不读 App 的 64 个 useState
 * 里的任何一个。留在同一个文件里只会让 App.tsx 的 diff 无法审阅。
 */
import type { ReactElement } from 'react';
import type {
  ContainerReadHint,
  ContainerReadSummary,
  MapExport,
  ParamExport,
  ResourceStructuredPreview
} from '@soulforge/shared';
import type { RendererBridgeResult } from '../../../main/rendererDto.js';
import { formatListTruncation } from '../format/uiText.js';

/**
 * 预览卡片各列表的渲染上限。
 *
 * 这些卡片是**证据摘要**，不是浏览器：完整浏览由对应工作台面板（分页通道）承担，
 * 所以这里保留硬截断而不加分页控件。但截断必须说出来——此前是静默 slice，用户
 * 看到 24 条会以为总共 24 条，而实际可能是 518 条里的前 24 条。
 */
const PREVIEW_LIMITS = {
  events: 24,
  paramRows: 32,
  mapEntities: 32,
  mapRegions: 32,
  textEntries: 24,
  binderChildRows: 80,
  containerHints: 40,
  inspectionLayers: 6,
  inspectionEvidence: 12,
  /** 行 tooltip 里列出的字段数（不是渲染列表，说明写在 title 文本里）。 */
  paramFieldsInTooltip: 6
} as const;

/** 截断说明的统一渲染。null 说明没截断，什么都不渲染。 */
function TruncationNote(
  { total, shown, noun, hint }: { total: number; shown: number; noun: string; hint?: string }
): ReactElement | null {
  const text = formatListTruncation({
    total,
    shown,
    noun,
    ...(hint ? { hint } : {})
  });
  if (!text) return null;
  return <p className="muted preview-truncation" data-testid="preview-truncation">{text}</p>;
}

export function StructuredPreviewCard({ preview }: { preview: ResourceStructuredPreview }): ReactElement {
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
          <TruncationNote
            total={eventCount}
            shown={Math.min(eventCount, PREVIEW_LIMITS.events)}
            noun="个事件"
            hint="完整事件表见 EMEVD 四视图编辑器"
          />
          <div className="structured-symbol-list">
            {preview.events.flatMap((eventExport) => eventExport.events).slice(0, PREVIEW_LIMITS.events).map((event) => (
              <span key={event.uri}>{event.eventId}{event.name ? ` · ${event.name}` : ''} · {event.instructions.length} instr</span>
            ))}
          </div>
        </details>
      )}
      {paramRows.length > 0 && (
        <details>
          <summary>Param rows</summary>
          <TruncationNote
            total={paramRows.length}
            shown={Math.min(paramRows.length, PREVIEW_LIMITS.paramRows)}
            noun="行"
            hint="完整行表见 PARAM 工作台（分页通道）"
          />
          <div className="structured-symbol-list">
            {paramRows.slice(0, PREVIEW_LIMITS.paramRows).map((row) => (
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
          <TruncationNote
            total={mapEntities.length}
            shown={Math.min(mapEntities.length, PREVIEW_LIMITS.mapEntities)}
            noun="个实体"
            hint="完整清单见 MSB 场景面板"
          />
          <div className="structured-symbol-list">
            {mapEntities.slice(0, PREVIEW_LIMITS.mapEntities).map((entity) => (
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
          <TruncationNote
            total={mapRegions.length}
            shown={Math.min(mapRegions.length, PREVIEW_LIMITS.mapRegions)}
            noun="个区域"
            hint="完整清单见 MSB 场景面板"
          />
          <div className="structured-symbol-list">
            {mapRegions.slice(0, PREVIEW_LIMITS.mapRegions).map((region) => (
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
          <TruncationNote
            total={msgCount}
            shown={Math.min(msgCount, PREVIEW_LIMITS.textEntries)}
            noun="条文本"
            hint="完整条目见 FMG 工作台（分页通道）"
          />
          <div className="structured-symbol-list">
            {preview.msgs.flatMap((msgExport) => msgExport.entries).slice(0, PREVIEW_LIMITS.textEntries).map((entry) => (
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

/**
 * 行 tooltip 里的字段摘要。
 *
 * 这里是 `title` 字符串而不是渲染列表，但同样不能静默截断：宽 PARAM 有数百字段，
 * 只列 6 个却不说，读 tooltip 的人会以为该行就这 6 个字段。
 */
function formatParamFieldPreview(fields: ParamExport['rows'][number]['fields']): string {
  if (!fields || fields.length === 0) return 'No typed fields are available yet.';
  const shown = fields.slice(0, PREVIEW_LIMITS.paramFieldsInTooltip);
  const summary = shown.map((field) => `${field.name}=${String(field.value)}`).join(', ');
  const hidden = fields.length - shown.length;
  return hidden > 0
    ? `${summary}（共 ${fields.length} 字段，另 ${hidden} 个未显示；完整字段见 PARAM 字段面板）`
    : summary;
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
        {rows.slice(0, PREVIEW_LIMITS.binderChildRows).map((row, index) => (
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
      <TruncationNote
        total={rows.length}
        shown={Math.min(rows.length, PREVIEW_LIMITS.binderChildRows)}
        noun="个子项"
        hint="完整子项表见 BND4 容器工作台（分页通道）"
      />
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
        {hints.slice(0, PREVIEW_LIMITS.containerHints).map((hint, index) => (
          <span key={`${hint.kind}-${hint.offset}-${index}`} title={JSON.stringify(hint.raw ?? {})}>
            {hint.offset.toString(16).padStart(8, '0')} · {hint.label} · {hint.resourceKind ?? hint.rootFormat ?? 'unknown'} · {hint.confidence}
          </span>
        ))}
      </div>
      <TruncationNote
        total={hints.length}
        shown={Math.min(hints.length, PREVIEW_LIMITS.containerHints)}
        noun="条线索"
      />
    </details>
  );
}

export interface NativeInspectionData {
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

export function NativeInspectionCard({ inspection }: { inspection: RendererBridgeResult<unknown> }): ReactElement {
  const data = asNativeInspectionData(inspection.data);
  const layers = data?.layers ?? [];
  const evidence = data?.evidence ?? [];
  const nextSteps = data?.nextSteps ?? [];

  return (
    <section className="native-inspection-card">
      <div className="native-inspection-title">
        <strong>原生格式检查</strong>
        <span>{inspection.parseStatus}</span>
      </div>
      <div className="native-inspection-grid">
        <span>资源类型：{data?.resourceKind ?? inspection.resourceKind}</span>
        <span>根格式：{data?.rootFormat ?? '未知'}</span>
        <span>容器层级：{layers.length}</span>
        <span>证据：{evidence.length}</span>
      </div>
      {layers.length > 0 && (
        <>
          <div className="native-chip-row">
            {layers.slice(0, PREVIEW_LIMITS.inspectionLayers).map((layer, index) => (
              <span key={`${layer.format ?? 'layer'}-${index}`} title={describeLayer(layer)}>
                {layer.format ?? '未知'} · {layer.confidence ?? '未知'}
              </span>
            ))}
          </div>
          <TruncationNote
            total={layers.length}
            shown={Math.min(layers.length, PREVIEW_LIMITS.inspectionLayers)}
            noun="层容器"
          />
        </>
      )}
      {evidence.length > 0 && (
        <details>
          <summary>证据线索</summary>
          <TruncationNote
            total={evidence.length}
            shown={Math.min(evidence.length, PREVIEW_LIMITS.inspectionEvidence)}
            noun="条证据"
          />
          <ul className="native-evidence-list">
            {evidence.slice(0, PREVIEW_LIMITS.inspectionEvidence).map((item, index) => (
              <li key={`${item.kind ?? 'evidence'}-${index}`}>
                <strong>{item.kind ?? '未知'}</strong>
                <span>offset={item.offset ?? 0}</span>
                <span>置信等级={item.confidence ?? '未知'}</span>
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

