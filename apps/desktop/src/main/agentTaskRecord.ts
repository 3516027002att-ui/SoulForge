import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentTaskRecordEntry,
  AgentTaskRecordGateway,
  AgentTaskRecordMutationRelease,
  AgentTaskRecordSearchInput,
  AgentTaskRecordSnapshot,
  AgentTaskRecordUpdate
} from '@soulforge/core';

const HEADER = `# SoulForge Agent Evidence 台账

此文件是本次 Agent 运行的格式化 Evidence 台账，不是 Mod 资源本身，也不替代原生读取、Patch Engine、备份或回滚。

- target 词条：先列出用户指令中可能需要修改的对象；
- evidence 词条：由搜索工具返回的 searchId 支持，propertyKey 是大小写不敏感的规范标识符；
- mutationBudget：该 Evidence 词条允许通过写入工具的次数；每次成功写入调用消耗一次；
- mutationUsed：已预留或已消耗的次数。次数用尽后必须重新搜索并写入新的 Evidence，或在实际资源回退后释放次数。

`;
const MAX_ENTRIES = 256;
const MAX_SEARCH_TICKETS = 512;
const SEARCH_TICKET_PREFIX = '<!-- soulforge-search-ticket ';
/** Coalesce the burst of ledger updates produced by one agent turn. */
const WRITE_DEBOUNCE_MS = 40;

interface SearchTicket {
  searchId: string;
  toolName: string;
  query: string;
  createdAt: string;
  usedBy?: string;
  resultText?: string;
  /** Exact PARAM identities observed in this search result. */
  paramTargets?: Array<{ table: string; rowId: number }>;
}

interface MutationReservation {
  entryIds: string[];
}

interface ParsedDocument {
  entries: AgentTaskRecordEntry[];
  tickets: SearchTicket[];
}

class TaskRecordError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'TaskRecordError';
  }
}

export function createAgentTaskRecordGateway(root: string, sessionId: string): AgentTaskRecordGateway {
  const filePath = join(root, `${sessionId}.md`);
  const searchTickets = new Map<string, SearchTicket>();
  const reservations = new Map<string, MutationReservation>();
  let operationTail = Promise.resolve();
  let cachedDocument: ParsedDocument | undefined;
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let persistenceError: TaskRecordError | undefined;
  let flushInFlight: Promise<void> | undefined;

  const withRecordLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = operationTail;
    let release!: () => void;
    operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const asPersistenceError = (error: unknown): TaskRecordError => error instanceof TaskRecordError
    ? error
    : new TaskRecordError(
      'TASK_RECORD_PERSIST_FAILED',
      `Evidence 台账写回失败：${error instanceof Error ? error.message : String(error)}`,
      { path: filePath }
    );

  const ensurePersistenceHealthy = (): void => {
    if (persistenceError) throw persistenceError;
  };

  const loadDocument = async (): Promise<ParsedDocument> => {
    ensurePersistenceHealthy();
    if (cachedDocument) return cachedDocument;
    await mkdir(root, { recursive: true });
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      content = HEADER;
      await writeFile(filePath, content, 'utf8');
    }
    cachedDocument = parseDocument(content);
    searchTickets.clear();
    for (const ticket of cachedDocument.tickets) searchTickets.set(ticket.searchId, ticket);
    return cachedDocument;
  };

  const snapshotOf = (entries: AgentTaskRecordEntry[]): AgentTaskRecordSnapshot => ({
    path: filePath,
    entries: entries.map((entry) => ({ ...entry, evidence: [...entry.evidence] })),
    updatedAt: entries.reduce<string | null>((latest, entry) => (
      latest === null || entry.updatedAt > latest ? entry.updatedAt : latest
    ), null)
  });

  const writeDocument = async (entries: AgentTaskRecordEntry[]): Promise<AgentTaskRecordSnapshot> => {
    await mkdir(root, { recursive: true });
    const ticketLines = [...searchTickets.values()]
      .slice(-MAX_SEARCH_TICKETS)
      .map((ticket) => `${SEARCH_TICKET_PREFIX}${JSON.stringify(ticket)} -->`)
      .join('\n');
    const entryBody = entries.map((entry) => [
      `## ${clean(entry.objectName)}`,
      `- ${clean(entry.propertyKey)}: ${clean(entry.value)}`,
      `  - entryId: ${clean(entry.entryId)}`,
      `  - kind: ${entry.kind}`,
      `  - status: ${entry.status}`,
      `  - evidence: ${entry.evidence.length > 0 ? entry.evidence.map(clean).join('；') : '未提供'}`,
      `  - mutationBudget: ${entry.mutationBudget}`,
      `  - mutationUsed: ${entry.mutationUsed}`,
      ...(entry.searchId ? [`  - searchId: ${clean(entry.searchId)}`] : []),
      `  - updatedAt: ${clean(entry.updatedAt)}`,
      ''
    ].join('\n')).join('\n');
    const sections = [HEADER.trimEnd(), ticketLines, entryBody].filter((section) => section.length > 0);
    await writeFile(filePath, `${sections.join('\n\n')}\n`, 'utf8');
    return snapshotOf(entries);
  };

  const cancelScheduledFlush = (): void => {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const flushPendingWrite = async (): Promise<void> => {
    ensurePersistenceHealthy();
    cancelScheduledFlush();
    if (!dirty || !cachedDocument) return;
    if (flushInFlight) {
      await flushInFlight;
      return;
    }
    dirty = false;
    const write = writeDocument(cachedDocument.entries)
      .then(() => undefined)
      .catch((error: unknown) => {
        dirty = true;
        persistenceError = asPersistenceError(error);
        throw persistenceError;
      });
    flushInFlight = write.finally(() => { flushInFlight = undefined; });
    await flushInFlight;
  };

  const scheduleWrite = (): void => {
    ensurePersistenceHealthy();
    dirty = true;
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void withRecordLock(async () => flushPendingWrite()).catch((error: unknown) => {
        persistenceError = asPersistenceError(error);
      });
    }, WRITE_DEBOUNCE_MS);
  };

  const readEntries = async (): Promise<AgentTaskRecordSnapshot> => withRecordLock(async () => {
    const parsed = await loadDocument();
    await flushPendingWrite();
    return snapshotOf(parsed.entries);
  });

  return {
    read: readEntries,
    beforeSearch: async ({ toolName, query }) => withRecordLock(async () => {
      if (clean(query) === '') {
        return {
          ok: false as const,
          code: 'TASK_RECORD_SEARCH_QUERY_REQUIRED',
          message: '搜索前必须提供非空查询；不能用空查询反复扫描任务记录。'
        };
      }
      const parsed = await loadDocument();
      const hasTarget = parsed.entries.some((entry) => (
        entry.kind === 'target'
        && entry.status !== 'blocked'
        && normalizeObjectName(entry.objectName).length > 0
      ));
      if (!hasTarget) {
        return {
          ok: false as const,
          code: 'TASK_RECORD_TARGETS_REQUIRED',
          message: `调用 ${toolName} 前必须先在 Evidence 台账列出可能需要修改的对象；请先写入 kind=target 的对象清单。`,
          details: { query }
        };
      }
      return { ok: true as const };
    }),
    recordSearch: async (input: AgentTaskRecordSearchInput) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const searchId = `search-${randomUUID()}`;
      const ticket: SearchTicket = {
        searchId,
        toolName: clean(input.toolName),
        query: clean(input.query),
        createdAt: new Date().toISOString(),
        resultText: serializeSearchResult(input.result),
        paramTargets: extractParamTargets(input.result)
      };
      searchTickets.set(searchId, ticket);
      while (searchTickets.size > MAX_SEARCH_TICKETS) {
        const oldest = searchTickets.keys().next().value as string | undefined;
        if (!oldest) break;
        searchTickets.delete(oldest);
      }
      parsed.tickets = [...searchTickets.values()];
      scheduleWrite();
      return { searchId, toolName: ticket.toolName, query: ticket.query };
    }),
    assertParamReadTarget: async (input: unknown) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const target = parseParamReadTarget(input);
      if (!target.ok) return target;
      const missing = target.rowIds.filter((rowId) => !hasRecordedParamTarget(parsed, target.table, rowId));
      if (missing.length === 0) return { ok: true as const };
      const rendered = missing.map((rowId) => `${target.table}#${rowId}`).join('、');
      return {
        ok: false as const,
        code: 'TASK_RECORD_PARAM_ROW_UNRESOLVED',
        message: `任务记录中没有找到 ${rendered} 的当前搜索/原生读取证据，已拒绝 PARAM 读取；请继续寻找并登记真实 rowId，不能把 textId、文件名片段或猜测数字当作行号。`,
        details: { table: target.table, rowIds: missing }
      };
    }),
    update: async (input: AgentTaskRecordUpdate) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const objectName = clean(input.objectName);
      const propertyKey = clean(input.propertyKey);
      const value = clean(input.value);
      const evidence = (input.evidence ?? []).map(clean).filter(Boolean).slice(0, 32);
      if (!objectName || !propertyKey || !value) {
        throw new TaskRecordError('INVALID_INPUT', 'Evidence 台账词条的 objectName、propertyKey 和 value 不能为空。');
      }

      const kind = input.kind ?? 'evidence';
      const searchId = input.searchId ? clean(input.searchId) : undefined;
      let evidenceMutationBudget = 0;
      if (kind === 'evidence') {
        if (evidence.length === 0) {
          throw new TaskRecordError('TASK_RECORD_EVIDENCE_REQUIRED', 'Evidence 台账词条必须包含格式化证据文本。');
        }
        if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(propertyKey)) {
          throw new TaskRecordError('TASK_RECORD_PROPERTY_KEY_INVALID', 'Evidence propertyKey 必须是大小写不敏感的字母数字下划线标识符，例如 atkparam_npc 或 npcparam。');
        }
        if (!searchId) throw new TaskRecordError('TASK_RECORD_SEARCH_TICKET_REQUIRED', 'Evidence 台账词条必须引用本次搜索返回的 searchId。');
        const ticket = searchTickets.get(searchId);
        if (!ticket) throw new TaskRecordError('TASK_RECORD_SEARCH_TICKET_INVALID', `搜索凭据 ${searchId} 不存在或已过期，请重新搜索。`);
        if (!ticketMatchesObject(ticket, objectName, parsed.entries)) {
          throw new TaskRecordError(
            'TASK_RECORD_SEARCH_OBJECT_MISSING',
            `searchId ${searchId} 的搜索结果没有出现对象 ${objectName} 且未关联该对象的已知 ID；不能用该搜索结果登记 Evidence。`,
            { searchId, objectName }
          );
        }
        if (!Number.isInteger(input.mutationBudget) || (input.mutationBudget ?? 0) < 1) {
          throw new TaskRecordError('TASK_RECORD_MUTATION_BUDGET_REQUIRED', 'Evidence 台账词条必须声明正整数 mutationBudget。');
        }
        evidenceMutationBudget = input.mutationBudget!;
        const target = parsed.entries.find((entry) => (
          entry.kind === 'target'
          && entry.status !== 'blocked'
          && normalizeObjectName(entry.objectName) === normalizeObjectName(objectName)
        ));
        if (!target) {
          throw new TaskRecordError(
            'TASK_RECORD_TARGET_NOT_DECLARED',
            `Evidence 对象 ${objectName} 未先在 target 词条中声明；请先列出可能需要修改的对象。`,
            { objectName }
          );
        }
      } else {
        if (normalizeKey(propertyKey) !== 'target') {
          throw new TaskRecordError('TASK_RECORD_TARGET_KEY_INVALID', '候选对象登记必须使用 propertyKey=target。');
        }
        if (input.searchId) {
          throw new TaskRecordError('TASK_RECORD_TARGET_SEARCH_ID_INVALID', 'target 词条只声明对象，不应携带 searchId。');
        }
        if (input.mutationBudget !== undefined && input.mutationBudget !== 0) {
          throw new TaskRecordError('TASK_RECORD_TARGET_BUDGET_INVALID', 'target 对象只用于声明候选对象，mutationBudget 必须省略或为 0。');
        }
      }

      const existingTarget = kind === 'target'
        ? parsed.entries.find((entry) => (
          entry.kind === 'target'
          && normalizeObjectName(entry.objectName) === normalizeObjectName(objectName)
        ))
        : undefined;
      const next: AgentTaskRecordEntry = {
        entryId: existingTarget?.entryId ?? `entry-${randomUUID()}`,
        objectName,
        propertyKey,
        value,
        kind,
        status: input.status ?? existingTarget?.status ?? 'candidate',
        evidence,
        mutationBudget: evidenceMutationBudget,
        mutationUsed: 0,
        ...(searchId ? { searchId } : {}),
        updatedAt: new Date().toISOString()
      };
      // target is a declaration and is replaced per object; each evidence
      // update is appended so a fresh search gets a fresh independent budget
      // while the previous count remains visible in the file.
      const entries = parsed.entries.filter((entry) => entry.entryId !== next.entryId);
      entries.push(next);
      parsed.entries = entries.slice(-MAX_ENTRIES);
      scheduleWrite();
      return snapshotOf(parsed.entries);
    }),
    assertMutationTarget: async (toolName: string, input: unknown) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const targets = mutationTargets(toolName, input);
      if (targets.length === 0) {
        return {
          ok: false as const,
          code: 'TASK_RECORD_PROPERTY_MISSING',
          message: '任务记录中没有找到本次写入的目标属性，已拒绝写入；请继续寻找并更新任务记录。'
        };
      }
      const matches: AgentTaskRecordEntry[] = [];
      for (const target of targets) {
        const match = [...parsed.entries].reverse().find((entry) => (
          entry.kind === 'evidence'
          && entry.status !== 'blocked'
          && entry.mutationUsed < entry.mutationBudget
          && mutationEvidenceMatches(entry, target)
        ));
        if (!match) {
          const hasKey = parsed.entries.some((entry) => (
            entry.kind === 'evidence'
            && mutationPropertyKeyMatches(entry.propertyKey, target.key)
          ));
          const hasTable = target.table !== undefined && target.rowId !== undefined
            ? parsed.entries.some((entry) => (
              entry.kind === 'evidence'
              && mutationEvidenceMatches(entry, target)
            ))
            : hasKey;
          const availablePropertyKeys = [...new Set(parsed.entries
            .filter((entry) => entry.kind === 'evidence' && entry.status !== 'blocked')
            .map((entry) => entry.propertyKey))]
            .slice(-16);
          return {
            ok: false as const,
            code: hasKey && !hasTable
              ? 'TASK_RECORD_PARAM_ROW_UNRESOLVED'
              : hasKey ? 'TASK_RECORD_MUTATION_BUDGET_EXHAUSTED' : 'TASK_RECORD_EVIDENCE_KEY_MISSING',
            message: hasKey && !hasTable
              ? `任务记录已有 ${target.key} 属性，但没有找到 ${target.table}#${target.rowId}${target.fieldId ? `.${target.fieldId}` : ''} 的证据；已拒绝写入，请继续寻找并更新任务记录。`
              : hasKey
              ? `Evidence 词条 ${target.key} 的 mutationBudget 已用尽；请实际回退后释放次数，或重新搜索并写入新的 Evidence。`
              : `Evidence 台账中没有词条 ${target.key}${target.fieldId ? `（字段 ${target.fieldId}）` : ''}；已拒绝 ${toolName} 写入，请使用已有字段证据的 propertyKey，或继续搜索并更新任务记录。`,
            details: { toolName, propertyKey: target.key, ...(target.fieldId ? { fieldId: target.fieldId } : {}), availablePropertyKeys }
          };
        }
        if (!matches.some((entry) => entry.entryId === match.entryId)) matches.push(match);
      }
      const now = new Date().toISOString();
      for (const entry of matches) {
        entry.mutationUsed += 1;
        entry.updatedAt = now;
      }
      const reservationId = `reservation-${randomUUID()}`;
      reservations.set(reservationId, { entryIds: matches.map((entry) => entry.entryId) });
      scheduleWrite();
      return { ok: true as const, reservationId };
    }),
    finalizeMutation: async (reservationId: string) => withRecordLock(async () => {
      reservations.delete(reservationId);
    }),
    releaseMutationReservation: async (reservationId: string) => withRecordLock(async () => {
      const reservation = reservations.get(reservationId);
      if (!reservation) return;
      const parsed = await loadDocument();
      const now = new Date().toISOString();
      for (const entry of parsed.entries) {
        if (reservation.entryIds.includes(entry.entryId)) {
          entry.mutationUsed = Math.max(0, entry.mutationUsed - 1);
          entry.updatedAt = now;
        }
      }
      reservations.delete(reservationId);
      scheduleWrite();
    }),
    releaseMutationCount: async (input: AgentTaskRecordMutationRelease) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const objectName = input.objectName ? normalizeObjectName(input.objectName) : null;
      const candidates = [...parsed.entries].reverse().filter((entry) => (
        entry.kind === 'evidence'
        && mutationPropertyKeyMatches(entry.propertyKey, input.propertyKey)
        && (objectName === null || normalizeObjectName(entry.objectName) === objectName)
        && entry.mutationUsed > 0
      ));
      const requested = input.count ?? 1;
      if (!Number.isInteger(requested) || requested < 1) {
        return {
          ok: false as const,
          code: 'TASK_RECORD_MUTATION_RELEASE_INVALID',
          message: '回退台账计数必须是正整数。',
          details: { requested }
        };
      }
      const available = candidates.reduce((sum, entry) => sum + entry.mutationUsed, 0);
      if (candidates.length === 0 || available < requested) {
        return {
          ok: false as const,
          code: 'TASK_RECORD_MUTATION_NOT_CONSUMED',
          message: `任务记录中没有可释放的 ${input.propertyKey} 修改次数。`,
          details: { propertyKey: input.propertyKey, requested, available }
        };
      }
      let remaining = requested;
      for (const entry of candidates) {
        const released = Math.min(entry.mutationUsed, remaining);
        entry.mutationUsed -= released;
        remaining -= released;
        if (remaining === 0) break;
      }
      scheduleWrite();
      const snapshot = snapshotOf(parsed.entries);
      return { ok: true as const, released: requested, snapshot };
    })
  };
}

function parseDocument(content: string): ParsedDocument {
  const entries: AgentTaskRecordEntry[] = [];
  const tickets: SearchTicket[] = [];
  let objectName = '';
  let pending: Partial<AgentTaskRecordEntry> | null = null;
  const flush = () => {
    if (pending?.propertyKey && pending.value !== undefined) entries.push(finalizeEntry(pending));
    pending = null;
  };

  for (const rawLine of content.split(/\r?\n/u)) {
    if (rawLine.startsWith(SEARCH_TICKET_PREFIX) && rawLine.endsWith(' -->')) {
      const rawTicket = rawLine.slice(SEARCH_TICKET_PREFIX.length, -4).trim();
      try {
        const value = JSON.parse(rawTicket) as Partial<SearchTicket>;
        if (typeof value.searchId === 'string' && value.searchId.trim() !== '') {
          tickets.push({
            searchId: clean(value.searchId),
            toolName: clean(typeof value.toolName === 'string' ? value.toolName : ''),
            query: clean(typeof value.query === 'string' ? value.query : ''),
            createdAt: clean(typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString()),
            ...(typeof value.usedBy === 'string' && value.usedBy.trim() !== '' ? { usedBy: clean(value.usedBy) } : {}),
            ...(typeof value.resultText === 'string' && value.resultText.trim() !== '' ? { resultText: clean(value.resultText) } : {}),
            ...(Array.isArray(value.paramTargets)
              ? {
                paramTargets: value.paramTargets
                  .filter((item): item is { table: string; rowId: number } => (
                    Boolean(item)
                    && typeof item === 'object'
                    && typeof (item as { table?: unknown }).table === 'string'
                    && Number.isSafeInteger((item as { rowId?: unknown }).rowId)
                  ))
                  .map((item) => ({ table: clean(item.table), rowId: item.rowId }))
                  .slice(0, 128)
              }
              : {})
          });
        }
      } catch {
        // A damaged ticket is ignored; an invalid ticket must never authorize a write.
      }
      continue;
    }
    const heading = /^##\s+(.+)$/u.exec(rawLine);
    if (heading) {
      flush();
      objectName = heading[1]!.trim();
      continue;
    }
    const property = /^-\s+([^:]+):\s*(.*)$/u.exec(rawLine);
    if (property && objectName) {
      flush();
      pending = { objectName, propertyKey: property[1]!.trim(), value: property[2]!.trim() };
      continue;
    }
    if (!pending) continue;
    const entryId = /^\s+-\s+entryId:\s+(.+)$/u.exec(rawLine);
    if (entryId) pending.entryId = entryId[1]!.trim();
    const kind = /^\s+-\s+kind:\s+(target|evidence)$/u.exec(rawLine);
    if (kind) pending.kind = kind[1] as AgentTaskRecordEntry['kind'];
    const status = /^\s+-\s+status:\s+(candidate|verified|blocked)$/u.exec(rawLine);
    if (status) pending.status = status[1] as AgentTaskRecordEntry['status'];
    const evidence = /^\s+-\s+evidence:\s+(.+)$/u.exec(rawLine);
    if (evidence && evidence[1] !== '未提供') pending.evidence = evidence[1]!.split('；').filter(Boolean);
    const mutationBudget = /^\s+-\s+mutationBudget:\s+(\d+)$/u.exec(rawLine);
    if (mutationBudget) pending.mutationBudget = Number(mutationBudget[1]);
    const mutationUsed = /^\s+-\s+mutationUsed:\s+(\d+)$/u.exec(rawLine);
    if (mutationUsed) pending.mutationUsed = Number(mutationUsed[1]);
    const searchId = /^\s+-\s+searchId:\s+(.+)$/u.exec(rawLine);
    if (searchId) pending.searchId = searchId[1]!.trim();
    const updatedAt = /^\s+-\s+updatedAt:\s+(.+)$/u.exec(rawLine);
    if (updatedAt) pending.updatedAt = updatedAt[1]!.trim();
  }
  flush();
  return { entries, tickets };
}

function finalizeEntry(entry: Partial<AgentTaskRecordEntry>): AgentTaskRecordEntry {
  // Records written before the target/evidence protocol are treated as
  // non-authorizing legacy Evidence, never as a target declaration.
  const kind = entry.kind ?? 'evidence';
  const mutationBudget = kind === 'evidence' && Number.isInteger(entry.mutationBudget) && entry.mutationBudget! > 0
    ? entry.mutationBudget!
    : 0;
  return {
    entryId: entry.entryId && entry.entryId.trim() !== '' ? entry.entryId : `entry-${randomUUID()}`,
    objectName: entry.objectName ?? '未命名对象',
    propertyKey: entry.propertyKey ?? '',
    value: entry.value ?? '',
    kind,
    status: entry.status ?? 'candidate',
    evidence: entry.evidence ?? [],
    mutationBudget,
    mutationUsed: Math.max(0, Math.min(mutationBudget, Number.isInteger(entry.mutationUsed) ? entry.mutationUsed! : 0)),
    ...(entry.searchId ? { searchId: entry.searchId } : {}),
    updatedAt: entry.updatedAt ?? new Date(0).toISOString()
  };
}

interface MutationTarget {
  key: string;
  table?: string;
  rowId?: number;
  fieldId?: string;
}

interface ParamReadTarget {
  table: string;
  rowIds: number[];
}

function parseParamReadTarget(
  input: unknown
): { ok: true } & ParamReadTarget | { ok: false; code: string; message: string; details?: unknown } {
  const record = asRecord(input);
  const table = typeof record.table === 'string' ? clean(record.table) : '';
  const rawRowIds = Array.isArray(record.rowIds) ? record.rowIds : [record.rowIds];
  const rowIds = [...new Set(rawRowIds
    .map((value) => typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN)
    .filter((value) => Number.isSafeInteger(value) && value >= 0))];
  if (!table || rowIds.length === 0) {
    return {
      ok: false,
      code: 'TASK_RECORD_PARAM_TARGET_REQUIRED',
      message: 'PARAM 读取需要明确的 table 和非空 rowIds；不能用未解析的数字片段继续读取。'
    };
  }
  return { ok: true, table, rowIds };
}

function normalizeParamTable(value: string): string {
  const leaf = value.replace(/\\/gu, '/').split('/').pop() ?? value;
  const compact = leaf
    .replace(/\.param$/iu, '')
    .replace(/[^a-z0-9]/giu, '')
    .toLocaleLowerCase();
  return compact.endsWith('st') && compact.length > 2 ? compact.slice(0, -2) : compact;
}

function paramTableTokenPresent(value: string, table: string): boolean {
  const compact = value
    .replace(/\\/gu, '/')
    .replace(/[^a-z0-9]/giu, '')
    .toLocaleLowerCase();
  const normalized = normalizeParamTable(table);
  return normalized.length > 0 && compact.includes(normalized);
}

function rowIdTokenPresent(value: string, rowId: number): boolean {
  return new RegExp(`(^|\\D)${rowId}(?=$|\\D)`, 'u').test(value);
}

function extractParamTargets(value: unknown): Array<{ table: string; rowId: number }> {
  const targets = new Map<string, { table: string; rowId: number }>();
  const visit = (node: unknown, inheritedTable = '', depth = 0): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, inheritedTable, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    const tableCandidates = [record.table, record.paramName, record.nativeTable, record.entryName]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    const table = tableCandidates[0] ?? inheritedTable;
    const rowIds: number[] = [];
    if (typeof record.rowId === 'number' && Number.isSafeInteger(record.rowId)) rowIds.push(record.rowId);
    if (Array.isArray(record.rowIds)) {
      for (const value of record.rowIds) {
        const rowId = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
        if (Number.isSafeInteger(rowId)) rowIds.push(rowId);
      }
    }
    if (table.trim().length > 0) {
      for (const rowId of rowIds) {
        const key = `${normalizeParamTable(table)}#${rowId}`;
        if (!targets.has(key)) targets.set(key, { table, rowId });
      }
    }
    for (const child of Object.values(record)) visit(child, table, depth + 1);
  };
  visit(value);
  return [...targets.values()].slice(0, 256);
}

function hasRecordedParamTarget(document: ParsedDocument, table: string, rowId: number): boolean {
  const normalizedTable = normalizeParamTable(table);
  const ticketMatch = document.tickets.some((ticket) => (
    ticket.paramTargets?.some((target) => (
      normalizeParamTable(target.table) === normalizedTable && target.rowId === rowId
    ))
    || extractParamTargetsFromText(ticket.resultText ?? '').some((target) => (
      normalizeParamTable(target.table) === normalizedTable && target.rowId === rowId
    ))
  ));
  if (ticketMatch) return true;
  return document.entries.some((entry) => entryAuthorizesParamTarget(entry, table, rowId));
}

function extractParamTargetsFromText(value: string): Array<{ table: string; rowId: number }> {
  if (!value.trim()) return [];
  try {
    return extractParamTargets(JSON.parse(value));
  } catch {
    return [];
  }
}

function entryAuthorizesParamTarget(entry: AgentTaskRecordEntry, table: string, rowId: number): boolean {
  const text = [entry.propertyKey, entry.value, ...entry.evidence].join('\n');
  return paramTableTokenPresent(text, table) && rowIdTokenPresent(text, rowId);
}

function mutationTargets(toolName: string, input: unknown): MutationTarget[] {
  const record = asRecord(input);
  if (toolName === 'mutate_param_fields') {
    const edits = asRecords(record.edits);
    return uniqueTargets(edits.map((edit) => ({
      key: String(edit.table ?? ''),
      ...(Number.isSafeInteger(Number(edit.rowId))
        ? { table: String(edit.table ?? ''), rowId: Number(edit.rowId) }
        : {}),
      ...(typeof edit.fieldId === 'string' && edit.fieldId.trim() !== ''
        ? { fieldId: edit.fieldId.trim() } : {})
    })));
  }
  if (toolName === 'mutate_fmg_entries') {
    const edits = asRecords(record.edits);
    return uniqueTargets(edits.map((edit) => ({ key: String(edit.table ?? '') })));
  }
  const file = typeof record.file === 'string' ? record.file.trim() : '';
  if (toolName === 'apply_emevd_dsl') {
    return file ? [{ key: 'emevd' }] : [];
  }
  if (toolName === 'mutate_tae_event_times') {
    return file ? [{ key: 'tae' }] : [];
  }
  if (toolName === 'mutate_msb_part_transform'
    || toolName === 'batch_transform_map_objects'
    || toolName === 'import_map_from_blender') {
    return file ? [{ key: 'msb' }] : [];
  }
  if (toolName === 'mutate_luabnd_script') {
    const childPath = typeof record.childPath === 'string' ? record.childPath.trim() : '';
    return [
      { key: 'luabnd' },
      { key: 'script' },
      ...(childPath ? [{ key: childPath }] : [])
    ];
  }
  if (toolName === 'commit_patch') {
    const changes = asRecords(record.changes);
    return changes.some((change) => typeof change.targetPath === 'string' && change.targetPath.trim() !== '')
      ? [{ key: 'patch' }]
      : [];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
  return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
}

function uniqueTargets(targets: MutationTarget[]): MutationTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = normalizeKey(target.key);
    const identity = target.table !== undefined && target.rowId !== undefined
      ? `${normalizeParamTable(target.table)}#${target.rowId}`
      : '';
    const field = target.fieldId ? normalizeKey(target.fieldId) : '';
    const dedupeKey = `${key}|${identity}|${field}`;
    if (!key || seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

function clean(value: string): string {
  return value.replace(/[\r\n]/gu, ' ').trim().slice(0, 4_000);
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function mutationPropertyKeyMatches(propertyKey: string, targetKey: string): boolean {
  const normalizedPropertyKey = normalizeParamTable(propertyKey);
  const normalizedTargetKey = normalizeParamTable(targetKey);
  return normalizedPropertyKey.length > 0
    && normalizedTargetKey.length > 0
    && (normalizedPropertyKey === normalizedTargetKey
      || normalizedPropertyKey.startsWith(normalizedTargetKey));
}

function mutationPropertyKeyMatchesField(propertyKey: string, fieldId: string): boolean {
  const property = compactIdentifier(propertyKey);
  const field = compactIdentifier(fieldId);
  return property.length > 0 && field.length > 0
    && (property === field || property.endsWith(field));
}

function mutationEvidenceMatches(entry: AgentTaskRecordEntry, target: MutationTarget): boolean {
  if (entry.kind !== 'evidence' || entry.status === 'blocked' || entry.mutationUsed >= entry.mutationBudget) return false;
  if (target.table !== undefined && target.rowId !== undefined
    && !entryAuthorizesParamTarget(entry, target.table, target.rowId)) return false;

  const tableMatch = mutationPropertyKeyMatches(entry.propertyKey, target.key);
  const fieldMatch = target.fieldId !== undefined
    && mutationPropertyKeyMatchesField(entry.propertyKey, target.fieldId);
  if (!tableMatch && !fieldMatch) return false;

  // A table-only propertyKey is valid only when its evidence explicitly
  // contains this edit's field. This prevents a generic NpcParam note from
  // authorizing an unrelated item-lot or effect field.
  if (tableMatch && target.fieldId !== undefined && !fieldEvidencePresent(entry, target.fieldId)) return false;
  return true;
}

function fieldEvidencePresent(entry: AgentTaskRecordEntry, fieldId: string): boolean {
  const field = compactIdentifier(fieldId);
  if (!field) return false;
  return [entry.value, ...entry.evidence].some((value) => compactIdentifier(value).includes(field));
}

function compactIdentifier(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLocaleLowerCase();
}

function normalizeObjectName(value: string): string {
  return normalizeChinese(value);
}

/** 任务记录只需要稳定的字符串匹配，不应在运行期依赖未发布的 core dist 导出。 */
function normalizeChinese(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase();
}

function containsObject(value: string, objectName: string): boolean {
  return normalizeObjectName(value).includes(normalizeObjectName(objectName));
}

function ticketMatchesObject(
  ticket: SearchTicket,
  objectName: string,
  existingEntries: AgentTaskRecordEntry[]
): boolean {
  const ticketText = `${ticket.query}\n${ticket.resultText ?? ''}`;
  if (containsObject(ticketText, objectName)) {
    return true;
  }

  // 检查 ticket 中出现的所有数字 ID（rowId / textId / eventId，至少 4 位数）
  // 如果该数字 ID 已经在此前属于该对象的 target/evidence 词条中登记或验证过，
  // 则说明本次搜索（如 search_param_fields 查该已知行的属性，或查对应 ID 的武器/掉落）属于该对象的合法证据补充。
  const idMatches = ticketText.match(/\b\d{4,9}\b/gu);
  if (idMatches && idMatches.length > 0) {
    const normObj = normalizeObjectName(objectName);
    const objectEntries = existingEntries.filter((entry) => (
      normalizeObjectName(entry.objectName) === normObj
    ));
    for (const entry of objectEntries) {
      const entryText = `${entry.value}\n${(entry.evidence ?? []).join('\n')}`;
      for (const id of idMatches) {
        if (entryText.includes(id)) {
          return true;
        }
      }
    }
  }

  return false;
}

function serializeSearchResult(result: unknown): string {
  try {
    return clean(JSON.stringify(result) ?? String(result));
  } catch {
    return clean(String(result));
  }
}
