import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentTaskRecordEntry,
  AgentTaskRecordGateway,
  AgentTaskRecordMutationRelease,
  AgentTaskRecordSearchInput,
  AgentTaskRecordSnapshot,
  AgentTaskRecordUpdate,
  HostResolvedEmevdEventTarget,
  NativeEmevdReadProofRequest
} from '@soulforge/core';

const HEADER = `# SoulForge Agent Evidence 台账

此文件是本次 Agent 运行的格式化 Evidence 台账，不是 Mod 资源本身，也不替代原生读取、Patch Engine、备份或回滚。

- target 词条：先列出用户指令中可能需要修改的对象；
- evidence 词条：由搜索工具返回的 searchId 支持，propertyKey 是大小写不敏感的规范标识符；
- 只读对照：用于比较取值但不会被修改的参考行/对象不登记为 target 或 evidence，直接使用搜索结果；
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
  /** Exact event identities returned by search_events; never inferred from text. */
  emevdTargets?: Array<{ sourceUri: string; eventId: number }>;
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

export interface AgentTaskRecordGatewayOptions {
  inheritFromSessionId?: string | undefined;
  /** Current host-owned user request. Model-authored targets cannot replace it. */
  frozenRequest?: string | undefined;
}

export function createAgentTaskRecordGateway(
  root: string,
  sessionId: string,
  options?: AgentTaskRecordGatewayOptions
): AgentTaskRecordGateway {
  const filePath = join(root, `${sessionId}.md`);
  const frozenRequest = clean(options?.frozenRequest ?? '');
  const searchTickets = new Map<string, SearchTicket>();
  const reservations = new Map<string, MutationReservation>();
  // Host-only, session-local receipts: a persisted entry's verified label is
  // not a receipt for every field mentioned in its model-authored text.
  const nativeParamProofs = new Map<string, Map<string, {
    table: string; sourceHash: string; sourceRevision: number;
  }>>();
  const nativeEmevdProofs = new Map<string, Map<string, {
    sourceUri: string;
    sourcePath: string;
    eventId: number;
    sourceHash: string;
    outerFileHash: string;
    sourceRevision: number;
    registryFingerprint: string;
  }>>();
  const proofKey = (table: string, rowId: number, fieldId: string): string => (
    JSON.stringify([normalizeParamTable(table), rowId, fieldId])
  );
  const emevdProofKey = (sourceUri: string, eventId: number): string => (
    JSON.stringify([sourceUri, eventId])
  );

  const hasNativeProof = (entry: AgentTaskRecordEntry, target: MutationTarget): boolean => (
    target.resourceKind === 'event'
      ? target.sourceUri !== undefined && target.eventId !== undefined
        && target.sourceHash !== undefined
        && target.outerFileHash !== undefined
        && target.sourceRevision !== undefined
        && (() => {
          const proof = nativeEmevdProofs.get(entry.entryId)?.get(emevdProofKey(target.sourceUri!, target.eventId!));
          return proof !== undefined
            && proof.sourceHash === target.sourceHash
            && proof.outerFileHash === target.outerFileHash
            && proof.sourceRevision === target.sourceRevision;
        })()
      : target.table === undefined || target.rowId === undefined || target.fieldId === undefined
        ? false
        : nativeParamProofs.get(entry.entryId)?.has(proofKey(target.table, target.rowId, target.fieldId)) === true
  );
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
      const inheritId = options?.inheritFromSessionId?.trim();
      if (inheritId && inheritId !== sessionId) {
        const parentPath = join(root, `${inheritId}.md`);
        try {
          content = await readFile(parentPath, 'utf8');
          await writeFile(filePath, content, 'utf8');
        } catch {
          content = HEADER;
          await writeFile(filePath, content, 'utf8');
        }
      } else {
        content = HEADER;
        await writeFile(filePath, content, 'utf8');
      }
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
    beforeSearch: async ({ query }) => withRecordLock(async () => {
      if (clean(query) === '') {
        return {
          ok: false as const,
          code: 'TASK_RECORD_SEARCH_QUERY_REQUIRED',
          message: '搜索前必须提供非空查询；不能用空查询反复扫描任务记录。'
        };
      }
      if (frozenRequest && !(await loadDocument()).entries.some((entry) => (
        entry.kind === 'target' && entry.status !== 'blocked'
      ))) {
        return {
          ok: false as const,
          code: 'TASK_RECORD_TARGET_REQUIRED',
          message: '搜索前必须先从当前用户指令逐字登记至少一个 target；模型不能用任意搜索替换宿主冻结的请求范围。'
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
        paramTargets: extractParamTargets(input.result),
        emevdTargets: extractEmevdTargets(input.toolName, input.result)
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

      if (input.status === 'verified') {
        throw new TaskRecordError(
          'TASK_RECORD_VERIFIED_HOST_ONLY',
          'verified 只能由宿主在成功原生读取后写入；模型不能自行声明已验证。'
        );
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
        if (normalizeKey(propertyKey) === 'emevd') {
          const emevdResolution = emevdEvidenceTargetResolution(ticket, objectName, value, evidence);
          if (!emevdResolution?.ok) {
            const ambiguous = emevdResolution?.reason === 'ambiguous';
            throw new TaskRecordError(
              ambiguous ? 'TASK_RECORD_EMEVD_TARGET_AMBIGUOUS' : 'TASK_RECORD_EMEVD_SEARCH_DOMAIN_REQUIRED',
              ambiguous
                ? 'search_events ticket 对同一 eventId 返回了多个 sourceUri；Evidence 必须明确写出精确 sourceUri+eventId，不能仅用 #eventId 或 basename 选择。'
                : 'EMEVD Evidence 必须引用 search_events 返回的结构化 sourceUri+eventId；不能用 MSB/PARAM/RAG 搜索结果或自由文本事件号替代。',
              {
                searchId,
                objectName,
                ...(emevdResolution ? {
                  eventId: emevdResolution.eventId,
                  candidates: emevdResolution.candidates
                } : {})
              }
            );
          }
        }
        if (!ticketMatchesObject(ticket, objectName, parsed.entries, [value, ...evidence])) {
          throw new TaskRecordError(
            'TASK_RECORD_SEARCH_OBJECT_MISSING',
            `searchId ${searchId} 的搜索结果没有出现对象 ${objectName} 且未关联该对象的已知 ID；不能用该搜索结果登记 Evidence。`,
            { searchId, objectName }
          );
        }
        if (input.mutationBudget !== 1) {
          throw new TaskRecordError('TASK_RECORD_MUTATION_BUDGET_INVALID', '当前宿主策略为每条 Evidence 只授权一次写入调用，mutationBudget 必须为 1。');
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
            `Evidence 对象 ${objectName} 未先在 target 词条中声明；请先列出可能需要修改的对象。若它只是用于比较取值的只读参考，不要登记 target/evidence，直接使用搜索结果继续处理真实修改目标。`,
            { objectName }
          );
        }
      } else {
        if (normalizeKey(propertyKey) !== 'target') {
          throw new TaskRecordError('TASK_RECORD_TARGET_KEY_INVALID', '候选对象登记必须使用 propertyKey=target。');
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
      if (kind === 'target' && frozenRequest && !existingTarget) {
        const directUserTarget = intentTextContains(frozenRequest, objectName);
        const ticket = searchId ? searchTickets.get(searchId) : undefined;
        const hasDeclaredUserTarget = parsed.entries.some((entry) => (
          entry.kind === 'target' && entry.status !== 'blocked'
        ));
        const derivedTarget = Boolean(
          ticket
          && hasDeclaredUserTarget
          && ticketMatchesObject(ticket, objectName, parsed.entries, [value, ...evidence])
        );
        if (!directUserTarget && !derivedTarget) {
          throw new TaskRecordError(
            'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST',
            `target ${objectName} 既未逐字来自当前用户指令，也没有由已登记对象的有效搜索结果解析得到；已拒绝扩大任务范围。若它只是用于比较取值的只读参考，不要登记 target/evidence，直接使用搜索结果继续处理真实修改目标。`,
            { objectName }
          );
        }
      }
      const next: AgentTaskRecordEntry = {
        entryId: existingTarget?.entryId ?? `entry-${randomUUID()}`,
        objectName,
        propertyKey,
        value,
        kind,
        status: input.status === 'blocked' ? 'blocked' : existingTarget?.status ?? 'candidate',
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
    recordNativeParamRead: async (input: unknown, result: unknown) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const requested = parseParamReadTarget(input);
      if (!requested.ok) {
        throw new TaskRecordError(requested.code, requested.message, requested.details);
      }
      const resultRecord = asRecord(result);
      const rawFieldIds = asRecord(input).fieldIds;
      const requestedFields = new Set(Array.isArray(rawFieldIds)
        ? rawFieldIds.filter((value): value is string => typeof value === 'string') : []);
      const fields = asRecords(resultRecord.fields).filter((field) => (
        Number(field.rowId) >= 0
        && Number.isSafeInteger(Number(field.rowId))
        && typeof field.fieldId === 'string'
        && field.fieldId.trim() !== ''
        && typeof field.sourceHash === 'string'
        && field.sourceHash.trim() !== ''
        && typeof field.sourceRevision === 'number'
        && Number.isFinite(field.sourceRevision)
        && requestedFields.has(field.fieldId as string)
      ));
      const promoted = new Set<string>();
      for (const field of fields) {
        const table = typeof field.table === 'string' && field.table.trim() !== ''
          ? field.table
          : requested.table;
        const rowId = Number(field.rowId);
        if (normalizeParamTable(table) !== normalizeParamTable(requested.table)
          || !requested.rowIds.includes(rowId)) continue;
        const normalizedTable = normalizeParamTable(table);
        const sourceHash = field.sourceHash as string;
        const sourceRevision = field.sourceRevision as number;
        // A new source identity invalidates all older receipts for this table.
        for (const proofs of nativeParamProofs.values()) {
          for (const [key, proof] of proofs) {
            if (proof.table === normalizedTable
              && (proof.sourceHash !== sourceHash || proof.sourceRevision !== sourceRevision)) proofs.delete(key);
          }
        }
        const target: MutationTarget = {
          key: requested.table,
          table: requested.table,
          rowId,
          fieldId: String(field.fieldId).trim()
        };
        for (const entry of parsed.entries) {
          if (entry.kind !== 'evidence' || entry.status === 'blocked') continue;
          if (mutationEvidenceMatches(entry, target)) {
            promoted.add(entry.entryId);
            const proofs = nativeParamProofs.get(entry.entryId) ?? new Map();
            proofs.set(proofKey(table, rowId, target.fieldId!), { table: normalizedTable, sourceHash, sourceRevision });
            nativeParamProofs.set(entry.entryId, proofs);
          }
        }
      }
      if (promoted.size === 0) {
        throw new TaskRecordError(
          'TASK_RECORD_NATIVE_PROOF_TARGET_MISSING',
          '原生 PARAM 读取成功，但没有匹配的 candidate Evidence 可晋升；请先用当前 searchId 登记精确表、行与字段。'
        );
      }
      const now = new Date().toISOString();
      for (const entry of parsed.entries) {
        if (!promoted.has(entry.entryId)) continue;
        entry.status = 'verified';
        entry.updatedAt = now;
      }
      scheduleWrite();
      return snapshotOf(parsed.entries);
    }),
    recordNativeEmevdRead: async (proof: NativeEmevdReadProofRequest) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const validation = validateNativeEmevdReadProof(proof);
      if (!validation.ok) {
        throw new TaskRecordError(validation.code, validation.message, validation.details);
      }
      const target = validation.target;
      const proofKeyForTarget = emevdProofKey(target.sourceUri, target.eventId);
      for (const proofs of nativeEmevdProofs.values()) {
        // A single native read fingerprints the outer EMEVD resource. When
        // that resource changes, every event receipt from the old version is
        // stale, not just the event that was reread now. Keeping another
        // event's old proof would let an unrelated event write bypass the
        // source CAS boundary after the same-file mutation.
        for (const [key, existing] of proofs) {
          if (existing.sourceUri === target.sourceUri
            && (existing.sourceHash !== validation.sourceHash
              || existing.outerFileHash !== validation.outerFileHash
              || existing.sourceRevision !== validation.sourceRevision)) {
            proofs.delete(key);
          }
        }
      }
      const targetMutation: MutationTarget = {
        key: 'emevd',
        resourceKind: 'event',
        sourceUri: target.sourceUri,
        eventId: target.eventId
      };
      const promoted = new Set<string>();
      for (const entry of parsed.entries) {
        // A persisted `verified` bit is not a native receipt by itself, but a
        // current host-observed complete read may refresh that entry's proof.
        if (entry.kind !== 'evidence' || entry.status === 'blocked') continue;
        if (!mutationEvidenceMatches(entry, targetMutation, searchTickets)) continue;
        promoted.add(entry.entryId);
        const proofs = nativeEmevdProofs.get(entry.entryId) ?? new Map();
        proofs.set(proofKeyForTarget, {
          sourceUri: target.sourceUri,
          sourcePath: target.sourcePath,
          eventId: target.eventId,
          sourceHash: validation.sourceHash,
          outerFileHash: validation.outerFileHash,
          sourceRevision: validation.sourceRevision,
          registryFingerprint: validation.registryFingerprint
        });
        nativeEmevdProofs.set(entry.entryId, proofs);
      }
      if (promoted.size === 0) {
        throw new TaskRecordError(
          'TASK_RECORD_NATIVE_PROOF_TARGET_MISSING',
          '原生 EMEVD 完整事件读取成功，但没有匹配当前 sourceUri+eventId 的 candidate Evidence 可晋升；未授予写入权限。'
        );
      }
      const now = new Date().toISOString();
      for (const entry of parsed.entries) {
        if (!promoted.has(entry.entryId)) continue;
        entry.status = 'verified';
        entry.updatedAt = now;
      }
      scheduleWrite();
      return snapshotOf(parsed.entries);
    }),
    assertMutationTarget: async (
      toolName: string,
      input: unknown,
      hostTarget?: HostResolvedEmevdEventTarget
    ) => withRecordLock(async () => {
      const parsed = await loadDocument();
      const targets = mutationTargets(toolName, input, hostTarget);
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
          && entry.status === 'verified'
          && entry.mutationUsed < entry.mutationBudget
          && mutationEvidenceMatches(entry, target, searchTickets)
          && hasNativeProof(entry, target)
        ));
        if (!match) {
          const unverifiedNativeEntries = parsed.entries.filter((entry) => (
            entry.kind === 'evidence'
            && (entry.status === 'candidate' || (entry.status === 'verified' && !hasNativeProof(entry, target)))
            && (target.resourceKind === 'event'
              ? mutationPropertyKeyMatches(entry.propertyKey, target.key)
              : mutationEvidenceMatches(entry, target, searchTickets))
          ));
          const hasUnverifiedNativeTarget = unverifiedNativeEntries.length > 0;
          const nativeProofState = target.resourceKind === 'event'
            ? undefined
            : unverifiedNativeEntries.some((entry) => entry.status === 'verified')
            ? 'verified_missing_native_proof' as const
            : unverifiedNativeEntries.some((entry) => entry.status === 'candidate')
            ? 'candidate' as const
            : undefined;
          const hasKey = parsed.entries.some((entry) => (
            entry.kind === 'evidence'
            && mutationPropertyKeyMatches(entry.propertyKey, target.key)
          ));
          const hasTable = target.resourceKind === 'event'
            ? hasKey
            : target.table !== undefined && target.rowId !== undefined
            ? parsed.entries.some((entry) => (
              entry.kind === 'evidence'
                && mutationEvidenceMatches(entry, target, searchTickets)
            ))
            : hasKey;
          const availablePropertyKeys = [...new Set(parsed.entries
            .filter((entry) => entry.kind === 'evidence' && entry.status !== 'blocked')
            .map((entry) => entry.propertyKey))]
            .slice(-16);
          const emevdReceiptIssues = target.resourceKind === 'event'
            ? nativeEmevdReceiptIssues(target)
            : undefined;
          return {
            ok: false as const,
            code: hasUnverifiedNativeTarget
              ? 'TASK_RECORD_NATIVE_PROOF_REQUIRED'
              : hasKey && !hasTable
              ? 'TASK_RECORD_PARAM_ROW_UNRESOLVED'
              : hasKey ? 'TASK_RECORD_MUTATION_BUDGET_EXHAUSTED' : 'TASK_RECORD_EVIDENCE_KEY_MISSING',
            message: hasUnverifiedNativeTarget
              ? target.resourceKind === 'event'
                ? `Evidence ${target.key} 仍未获得与 sourceUri+eventId 精确绑定的当前完整 native EMEVD read proof；${emevdReceiptIssues?.missing.length
                  ? `本次写回缺少：${emevdReceiptIssues.missing.join('、')}；`
                  : emevdReceiptIssues?.mismatch
                    ? '提交的 sourceHash、outerFileHash 或 sourceRevision 与最近原生读取不一致；'
                    : ''}请重新读取完整 darkscript 事件（offset=0、returned=total、darkScriptComplete=true），再写回。`
                : nativeProofState === 'verified_missing_native_proof'
                ? `Evidence ${target.key} 已登记为 verified，但 ${target.table}#${target.rowId}.${target.fieldId} 缺少当前 session 的 native read proof；请重新读取该精确表、行和字段后再写入。`
                : `Evidence ${target.key} 对 ${target.table}#${target.rowId}.${target.fieldId} 仍是 candidate；必须先完成匹配表、行和字段的原生读取，由宿主晋升为 verified 后才能写入。`
              : hasKey && !hasTable
              ? `任务记录已有 ${target.key} 属性，但没有找到 ${target.table}#${target.rowId}${target.fieldId ? `.${target.fieldId}` : ''} 的证据；已拒绝写入，请继续寻找并更新任务记录。`
              : hasKey
              ? `Evidence 词条 ${target.key} 的 mutationBudget 已用尽；请实际回退后释放次数，或重新搜索并写入新的 Evidence。`
              : `Evidence 台账中没有词条 ${target.key}${target.fieldId ? `（字段 ${target.fieldId}）` : ''}；已拒绝 ${toolName} 写入，请使用已有字段证据的 propertyKey，或继续搜索并更新任务记录。`,
            details: {
              toolName,
              propertyKey: target.key,
              ...(target.fieldId ? { fieldId: target.fieldId } : {}),
              availablePropertyKeys,
              ...(target.resourceKind === 'event' ? {} : {
                target: {
                  resourceKind: 'param' as const,
                  table: target.table,
                  rowId: target.rowId,
                  fieldId: target.fieldId
                },
                ...(nativeProofState ? { nativeProofState } : {}),
                ...(target.table !== undefined && target.rowId !== undefined && target.fieldId !== undefined
                  ? {
                    requiredRead: {
                      table: target.table,
                      rowIds: [target.rowId],
                      fieldIds: [target.fieldId]
                    }
                  }
                  : {})
              }),
              ...(emevdReceiptIssues ? {
                requiredIdentity: ['sourceHash', 'outerFileHash', 'sourceRevision', 'darkScriptComplete=true'],
                missingIdentity: emevdReceiptIssues.missing,
                identityMismatch: emevdReceiptIssues.mismatch
              } : {})
            }
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
      // A commit may replace the outer PARAM container. Subsequent writes
      // need fresh native reads, including after an operation is rolled back.
      nativeParamProofs.clear();
      nativeEmevdProofs.clear();
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
      // A failed native write (including CAS failure) must force a fresh
      // complete event read before any retry; the reservation count itself is
      // released below and PARAM proof behavior remains unchanged.
      nativeEmevdProofs.clear();
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
      if (normalizeKey(input.propertyKey) === 'emevd') nativeEmevdProofs.clear();
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
              : {}),
            ...(Array.isArray(value.emevdTargets)
              ? {
                emevdTargets: value.emevdTargets
                  .filter((item): item is { sourceUri: string; eventId: number } => (
                    Boolean(item)
                    && typeof item === 'object'
                    && typeof (item as { sourceUri?: unknown }).sourceUri === 'string'
                    && (item as { sourceUri: string }).sourceUri.trim() !== ''
                    && Number.isSafeInteger((item as { eventId?: unknown }).eventId)
                  ))
                  .map((item) => ({ sourceUri: normalizeEmevdSourceUriHint(clean(item.sourceUri)), eventId: item.eventId }))
                  .slice(0, 256)
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
    ? 1
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
  resourceKind?: 'event';
  sourceUri?: string;
  eventId?: number;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
}

function nativeEmevdReceiptIssues(target: MutationTarget): { missing: string[]; mismatch: boolean } {
  const missing = [
    target.sourceHash === undefined ? 'sourceHash' : null,
    target.outerFileHash === undefined ? 'outerFileHash' : null,
    target.sourceRevision === undefined || !Number.isFinite(target.sourceRevision) ? 'sourceRevision' : null
  ].filter((item): item is string => item !== null);
  return { missing, mismatch: missing.length === 0 };
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

function normalizeIntentText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function intentTextContains(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeIntentText(haystack);
  const normalizedNeedle = normalizeIntentText(needle);
  return normalizedNeedle.length >= 2 && normalizedHaystack.includes(normalizedNeedle);
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
  const visit = (node: unknown, inheritedTables: string[] = [], depth = 0): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, inheritedTables, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    const tableCandidates = [record.table, record.paramName, record.nativeTable, record.entryName]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    // A native row can carry both a logical type (ATK_PARAM_ST) and the
    // physical BND4 entry (AtkParam_Npc.param).  Record every identity the
    // result actually returned.  Taking only [0] loses the physical entry and
    // forces a later read of the explicit entry to fail; synthesizing sibling
    // entries from the shared type would be worse because it grants guessed
    // authority.  No aliases are generated here: only literal result fields
    // and the inherited object path are receipts. An explicit identity on a
    // child replaces, rather than unions with, its parent scope: a container
    // named AtkParam_Pc must not authorize a nested row explicitly returned as
    // AtkParam_Npc (or vice versa).
    const tables = tableCandidates.length > 0
      ? [...new Set(tableCandidates)]
      : inheritedTables;
    const rowIds: number[] = [];
    if (typeof record.rowId === 'number' && Number.isSafeInteger(record.rowId)) rowIds.push(record.rowId);
    if (Array.isArray(record.rowIds)) {
      for (const value of record.rowIds) {
        const rowId = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
        if (Number.isSafeInteger(rowId)) rowIds.push(rowId);
      }
    }
    if (tables.length > 0) {
      for (const candidateTable of tables) {
        for (const rowId of rowIds) {
          const key = `${normalizeParamTable(candidateTable)}#${rowId}`;
          if (!targets.has(key)) targets.set(key, { table: candidateTable, rowId });
        }
      }
    }
    const childInheritedTables = tableCandidates.length > 0
      ? [...new Set(tableCandidates)]
      : inheritedTables;
    for (const child of Object.values(record)) visit(child, childInheritedTables, depth + 1);
  };
  visit(value);
  return [...targets.values()].slice(0, 256);
}

function extractEmevdTargets(
  toolName: string,
  value: unknown
): Array<{ sourceUri: string; eventId: number }> {
  if (normalizeKey(toolName) !== 'search_events') return [];
  const targets = new Map<string, { sourceUri: string; eventId: number }>();
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 10 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    const eventId = typeof record.eventId === 'number' && Number.isSafeInteger(record.eventId)
      ? record.eventId
      : undefined;
    // Only the structured sourceUri emitted by search_events is a file
    // identity. `file`/`sourcePath` are model-facing hints and can be a
    // basename or a physical path from another domain; accepting them here
    // would make a wrong-domain/cross-file ticket look authoritative.
    const sourceUri = typeof record.sourceUri === 'string' && record.sourceUri.trim() !== ''
      ? normalizeEmevdSourceUriHint(clean(record.sourceUri))
      : undefined;
    if (eventId !== undefined && sourceUri !== undefined) {
      targets.set(JSON.stringify([sourceUri, eventId]), { sourceUri, eventId });
    }
    Object.values(record).forEach((child) => visit(child, depth + 1));
  };
  visit(value);
  return [...targets.values()].slice(0, 256);
}

function extractEmevdEventIdHints(values: readonly string[]): number[] {
  const ids = new Set<number>();
  const patterns = [
    // A labelled eventId is already an explicit identity; do not impose the
    // old four-digit heuristic. Small native events (including 0/1) are
    // valid API targets. Bare prose numbers remain excluded below.
    /(?:event(?:id)?|事件)\s*[:=#]?\s*(-?\d+)/giu,
    /#(-?\d+)/gu,
    /(?:^|[^\d])E(\d{7,})(?=$|[^\d])/giu
  ];
  for (const value of values) {
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const raw = match[1];
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        if (Number.isSafeInteger(parsed)) ids.add(parsed);
      }
    }
  }
  return [...ids];
}

function extractEmevdSourceUriHints(values: readonly string[]): string[] {
  const uris = new Set<string>();
  const patterns = [
    /(?:sourceuri|source-uri)\s*[:=]\s*["']?([^\s,;"']+)/giu,
    /\b(file:\/\/[^\s,;"')]+)\b/giu
  ];
  for (const value of values) {
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const candidate = match[1]?.trim();
        if (candidate) uris.add(normalizeEmevdSourceUriHint(candidate));
      }
    }
  }
  return [...uris];
}

function normalizeEmevdSourceUriHint(value: string): string {
  return value.trim().replace(/#event\/-?\d+$/iu, '');
}

type EmevdTicketTargetResolution =
  | { ok: true; target: { sourceUri: string; eventId: number } }
  | {
    ok: false;
    reason: 'missing' | 'ambiguous';
    eventId: number;
    candidates: Array<{ sourceUri: string; eventId: number }>;
  };

function resolveEmevdTicketTarget(
  ticket: SearchTicket,
  values: readonly string[],
  eventId: number
): EmevdTicketTargetResolution {
  if (normalizeKey(ticket.toolName) !== 'search_events') {
    return { ok: false, reason: 'missing', eventId, candidates: [] };
  }
  const candidates = (ticket.emevdTargets ?? []).filter((target) => target.eventId === eventId);
  if (candidates.length === 0) return { ok: false, reason: 'missing', eventId, candidates };
  const sourceHints = extractEmevdSourceUriHints(values);
  if (sourceHints.length > 0) {
    const exact = candidates.filter((candidate) => sourceHints.includes(normalizeEmevdSourceUriHint(candidate.sourceUri)));
    if (exact.length === 1) return { ok: true, target: exact[0]! };
    if (exact.length > 1) {
      return { ok: false, reason: 'ambiguous', eventId, candidates: exact };
    }
    return { ok: false, reason: 'missing', eventId, candidates };
  }
  // An event ID alone is safe only when this ticket contains exactly one
  // source for that ID. If a search returned the same ID from two files, the
  // Evidence entry must quote/select a sourceUri explicitly.
  return candidates.length === 1
    ? { ok: true, target: candidates[0]! }
    : { ok: false, reason: 'ambiguous', eventId, candidates };
}

function emevdEvidenceTargetResolution(
  ticket: SearchTicket,
  objectName: string,
  value: string,
  evidence: readonly string[]
): EmevdTicketTargetResolution | null {
  const values = [objectName, value, ...evidence];
  const eventIds = extractEmevdEventIdHints(values);
  if (eventIds.length === 0) return null;
  // A single Evidence entry must choose one event. Multiple numeric IDs are
  // not a safe substitute for a structured event target.
  if (eventIds.length !== 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      eventId: eventIds[0]!,
      candidates: (ticket.emevdTargets ?? []).filter((target) => eventIds.includes(target.eventId))
    };
  }
  return resolveEmevdTicketTarget(ticket, values, eventIds[0]!);
}

function ticketMatchesEmevdTarget(
  ticket: SearchTicket,
  entry: AgentTaskRecordEntry,
  target: MutationTarget
): boolean {
  if (normalizeKey(ticket.toolName) !== 'search_events'
    || target.sourceUri === undefined || target.eventId === undefined) return false;
  const values = [
    entry.objectName,
    entry.value,
    ...entry.evidence
  ];
  const resolution = resolveEmevdTicketTarget(ticket, values, target.eventId);
  return resolution.ok && resolution.target.sourceUri === target.sourceUri;
}

function ticketMatchesEmevdEvidence(
  ticket: SearchTicket,
  objectName: string,
  value: string,
  evidence: readonly string[]
): boolean {
  return emevdEvidenceTargetResolution(ticket, objectName, value, evidence)?.ok === true;
}

interface ValidatedNativeEmevdProof {
  ok: true;
  target: HostResolvedEmevdEventTarget;
  sourceHash: string;
  outerFileHash: string;
  sourceRevision: number;
  registryFingerprint: string;
}

function validateNativeEmevdReadProof(
  proof: NativeEmevdReadProofRequest
): ValidatedNativeEmevdProof | { ok: false; code: string; message: string; details?: unknown } {
  const target = proof?.target;
  const raw = asRecord(proof?.rawResult);
  const envelope = asRecord(proof?.envelope);
  const envelopeData = asRecord(envelope.data);
  const delivered = asRecord(envelopeData.record);
  const pagination = asRecord(envelope.pagination);
  const fail = (message: string, details?: unknown) => ({
    ok: false as const,
    code: 'TASK_RECORD_NATIVE_PROOF_INCOMPLETE',
    message,
    ...(details === undefined ? {} : { details })
  });
  if (!target || target.resourceKind !== 'event' || target.canonical !== true
    || typeof target.sourceUri !== 'string' || target.sourceUri.trim() === ''
    || typeof target.sourcePath !== 'string' || target.sourcePath.trim() === ''
    || !Number.isSafeInteger(target.eventId)) {
    return fail('EMEVD native receipt 缺少宿主 canonical sourceUri/path/eventId；未授予写入权限。');
  }
  if (envelope.ok !== true || envelope.completeness !== 'complete' || envelope.truncated !== false
    || pagination.truncated !== false || pagination.offset !== 0) {
    return fail('最终 bounded envelope 不是完整 native DSL 视图；未授予写入权限。');
  }
  if (delivered.projection !== 'complete_native_dsl'
    || delivered.format !== 'darkscript'
    || delivered.resourceKind !== 'event'
    || delivered.darkScriptComplete !== true
    || typeof delivered.darkScript !== 'string'
    || delivered.darkScript.trim() === '') {
    return fail('最终 bounded envelope 没有交付未改动的完整 DarkScript；未授予写入权限。');
  }
  const rawEventId = typeof raw.eventId === 'number' ? raw.eventId : Number.NaN;
  const rawTotal = typeof raw.total === 'number' ? raw.total : Number.NaN;
  const rawReturned = typeof raw.returned === 'number' ? raw.returned : Number.NaN;
  const rawOffset = typeof raw.offset === 'number' ? raw.offset : Number.NaN;
  const rawReadRange = asRecord(raw.readRange);
  if (raw.ok !== true
    || raw.resourceKind !== 'event'
    || raw.format !== 'darkscript'
    || raw.darkScriptComplete !== true
    || !Number.isSafeInteger(rawEventId) || rawEventId !== target.eventId
    || !Number.isSafeInteger(rawTotal) || rawTotal < 0
    || !Number.isSafeInteger(rawReturned) || rawReturned !== rawTotal
    || rawOffset !== 0 || raw.instructionCount !== rawTotal
    || raw.truncated !== false
    || rawReadRange.start !== 0 || rawReadRange.end !== rawTotal
    || typeof raw.darkScript !== 'string' || raw.darkScript.trim() === '') {
    return fail('native 原始读取本身不是完整 darkscript event window；不能用投影字段自报完整。');
  }
  if (Array.isArray(raw.instructions) && raw.instructions.length !== rawTotal) {
    return fail('native 原始读取携带的 machine instruction 数量与 total 不一致。');
  }
  const eventId = typeof delivered.eventId === 'number' ? delivered.eventId : Number.NaN;
  const total = typeof delivered.total === 'number' ? delivered.total : Number.NaN;
  const returned = typeof delivered.returned === 'number' ? delivered.returned : Number.NaN;
  const offset = typeof delivered.offset === 'number' ? delivered.offset : Number.NaN;
  if (!Number.isSafeInteger(eventId) || eventId !== target.eventId
    || !Number.isSafeInteger(total) || total < 0
    || !Number.isSafeInteger(returned) || returned !== total
    || offset !== 0 || delivered.instructionCount !== total
    || delivered.truncated !== false) {
    return fail('完整 native DSL 视图的事件窗口身份不完整或不一致；未授予写入权限。');
  }
  const readRange = asRecord(delivered.readRange);
  if (readRange.start !== 0 || readRange.end !== total) {
    return fail('完整 native DSL 视图的 readRange 不是整个事件；未授予写入权限。');
  }
  if (pagination.total !== total || pagination.returnedCount !== total) {
    return fail('最终 bounded envelope 的 pagination 未证明完整事件窗口；未授予写入权限。');
  }
  const sourceHash = typeof raw.sourceHash === 'string' ? raw.sourceHash.trim() : '';
  const outerFileHash = typeof raw.outerFileHash === 'string' ? raw.outerFileHash.trim() : '';
  const sourceRevision = raw.sourceRevision;
  const registryFingerprint = typeof raw.registryFingerprint === 'string'
    ? raw.registryFingerprint.trim()
    : '';
  if (!sourceHash || !outerFileHash || typeof sourceRevision !== 'number' || !Number.isFinite(sourceRevision)
    || !registryFingerprint) {
    return fail('EMEVD native receipt 缺少 sourceHash、outerFileHash、有限 sourceRevision 或 registryFingerprint。');
  }
  const rawPath = typeof raw.sourcePath === 'string' ? raw.sourcePath : raw.filePath;
  if (typeof rawPath !== 'string' || normalizeNativePath(rawPath) !== normalizeNativePath(target.sourcePath)) {
    return fail('native 读取的物理文件与宿主 canonical event target 不一致；未授予写入权限。');
  }
  const identityKeys: Array<[string, unknown]> = [
    ['sourceUri', raw.sourceUri],
    ['sourceHash', raw.sourceHash],
    ['outerFileHash', raw.outerFileHash],
    ['sourceRevision', raw.sourceRevision],
    ['registryFingerprint', raw.registryFingerprint]
  ];
  for (const [key, rawValue] of identityKeys) {
    if (rawValue === undefined || delivered[key] !== rawValue) {
      return fail(`native receipt 字段 ${key} 未被最终 envelope 逐字保留；未授予写入权限。`);
    }
  }
  if (raw.sourceUri !== target.sourceUri) {
    return fail('native 读取的 sourceUri 与宿主 canonical event target 不一致；未授予写入权限。');
  }
  for (const key of ['eventId', 'instructionCount', 'total', 'offset', 'returned', 'truncated', 'darkScriptComplete', 'format', 'resourceKind'] as const) {
    if (delivered[key] !== raw[key]) {
      return fail(`native receipt 字段 ${key} 未与原始读取逐字对齐；未授予写入权限。`);
    }
  }
  if (JSON.stringify(delivered.readRange) !== JSON.stringify(raw.readRange)) {
    return fail('最终 envelope 的 readRange 与原始读取不一致；未授予写入权限。');
  }
  if (delivered.darkScript !== raw.darkScript) {
    return fail('最终 envelope 的 DarkScript 与 native 原始读取不一致；未授予写入权限。');
  }
  return {
    ok: true,
    target,
    sourceHash,
    outerFileHash,
    sourceRevision,
    registryFingerprint
  };
}

function normalizeNativePath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase();
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

function mutationTargets(
  toolName: string,
  input: unknown,
  hostTarget?: HostResolvedEmevdEventTarget
): MutationTarget[] {
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
    if (!file) return [];
    const scope = record.scope === 'event' && hostTarget?.eventId !== undefined
      ? {
          resourceKind: 'event' as const,
          sourceUri: hostTarget.sourceUri,
          eventId: hostTarget.eventId,
          ...(typeof record.sourceHash === 'string' && record.sourceHash.trim() !== ''
            ? { sourceHash: record.sourceHash.trim() } : {}),
          ...(typeof record.outerFileHash === 'string' && record.outerFileHash.trim() !== ''
            ? { outerFileHash: record.outerFileHash.trim() } : {}),
          ...(typeof record.sourceRevision === 'number' && Number.isFinite(record.sourceRevision)
            ? { sourceRevision: record.sourceRevision } : {})
        }
      : {};
    return [{ key: 'emevd', ...scope }];
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

function mutationEvidenceMatches(
  entry: AgentTaskRecordEntry,
  target: MutationTarget,
  tickets?: Map<string, SearchTicket>
): boolean {
  if (entry.kind !== 'evidence' || entry.status === 'blocked' || entry.mutationUsed >= entry.mutationBudget) return false;
  if (target.resourceKind === 'event') {
    if (target.sourceUri === undefined || target.eventId === undefined || !tickets) return false;
    const ticket = entry.searchId ? tickets.get(entry.searchId) : undefined;
    if (!ticket || !ticketMatchesEmevdTarget(ticket, entry, target)) return false;
  }
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
  const normalized = normalizeChinese(value);
  // 用户常用译名与原生 rowName 的已知异体字只在对象名比较层归一。
  // 绝不能把该映射用于 rowId、fieldId、sourceHash 或 native 数据本身。
  if (normalized === '鬼刑部') return '鬼形部';
  return normalized;
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

function parseStandaloneEventId(value: string): number | undefined {
  const candidate = value.trim();
  if (!/^-?\d+$/u.test(candidate)) return undefined;
  const eventId = Number(candidate);
  return Number.isSafeInteger(eventId) ? eventId : undefined;
}

/**
 * A numeric EMEVD target may be derived only from the structured identity
 * emitted by search_events.  The bounded resultText is intentionally not a
 * fallback here: it is a model-facing projection and may be truncated.
 *
 * A ticket can contain the same eventId in more than one file.  The existing
 * resolver therefore requires either one candidate or an exact sourceUri
 * hint; without that hint the case stays fail-closed.  If the target's
 * value/evidence quotes an eventId or sourceUri, those hints must agree with
 * the exact candidate; conflicting hints must never be hidden by a text
 * match.
 */
function ticketMatchesStructuredEmevdObject(
  ticket: SearchTicket,
  objectName: string,
  relatedValues: readonly string[]
): boolean {
  if (normalizeKey(ticket.toolName) !== 'search_events') return false;
  const eventId = parseStandaloneEventId(objectName);
  if (eventId === undefined) return false;

  const eventHints = extractEmevdEventIdHints(relatedValues);
  if (eventHints.length > 0 && (eventHints.length !== 1 || eventHints[0] !== eventId)) return false;
  const sourceHints = extractEmevdSourceUriHints(relatedValues);
  // Multiple source hints are ambiguous even if one happens to match a
  // candidate.  This prevents a conflicting source from being hidden by the
  // resolver's exact-match branch.
  if (sourceHints.length > 1) return false;
  const resolution = resolveEmevdTicketTarget(ticket, relatedValues, eventId);
  if (!resolution.ok) return false;
  return sourceHints.length === 0 || sourceHints[0] === resolution.target.sourceUri;
}

function ticketMatchesObject(
  ticket: SearchTicket,
  objectName: string,
  existingEntries: AgentTaskRecordEntry[],
  relatedValues: readonly string[] = []
): boolean {
  // Numeric event targets are a separate identity path.  In particular, do
  // not let a search_events resultText mention, stale text-id, or free-form
  // prose authorize an event that is absent from structured emevdTargets.
  if (normalizeKey(ticket.toolName) === 'search_events'
    && parseStandaloneEventId(objectName) !== undefined) {
    return ticketMatchesStructuredEmevdObject(ticket, objectName, relatedValues);
  }

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
