/**
 * ORIGINAL test fixtures for reference-optimization and native-read-proof smokes.
 *
 * Every exported type/value is synthetic test data (Fixture* prefix). Hashes are
 * always real sha256 digests via createHash — never placeholder strings like 'H0'.
 * Port counters live on createFixtureNativePorts(); production paths must not be
 * hand-counted inside the production modules under test.
 */
import { createHash } from 'node:crypto';

export function fixtureSha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bytes used to mint deterministic fixture hashes. Distinct labels → distinct digests. */
export function fixtureBytes(label: string): Buffer {
  return Buffer.from(`fixture:soulforge:${label}`, 'utf8');
}

export function fixtureHash(label: string): string {
  return fixtureSha256(fixtureBytes(label));
}

// ── Workspace pair: same relative paths / tables / rowIds, different values ──

export interface FixtureWorkspaceParamRow {
  table: string;
  rowId: number;
  rowIndex: number;
  fieldId: string;
  value: number | string;
}

export interface FixtureWorkspaceSide {
  workspaceId: string;
  sourceUri: string;
  relativePath: string;
  rows: FixtureWorkspaceParamRow[];
  outerFileHash: string;
  childHash: string;
  dataHash: string;
  mtimeMs: number;
}

export interface FixtureWorkspacePair {
  kind: 'FixtureWorkspacePair';
  left: FixtureWorkspaceSide;
  right: FixtureWorkspaceSide;
  /** True when relative paths / tables / rowIds match and only values differ. */
  sameLayout: true;
  differingFieldIds: string[];
}

export function createFixtureWorkspacePair(): FixtureWorkspacePair {
  const table = 'FixtureNpcParam';
  const rowId = 91000100;
  const rowIndex = 3;
  const sharedMtime = 1_700_000_000_000;
  const left: FixtureWorkspaceSide = {
    workspaceId: 'fixture-ws-left',
    sourceUri: 'gameparam://fixture/NpcParam',
    relativePath: 'param/NpcParam.parambnd',
    rows: [
      { table, rowId, rowIndex, fieldId: 'hp', value: 800 },
      { table, rowId, rowIndex, fieldId: 'stamina', value: 120 }
    ],
    outerFileHash: fixtureHash('ws-left-outer'),
    childHash: fixtureHash('ws-left-child'),
    dataHash: fixtureHash('ws-left-data'),
    mtimeMs: sharedMtime
  };
  const right: FixtureWorkspaceSide = {
    workspaceId: 'fixture-ws-right',
    sourceUri: 'gameparam://fixture/NpcParam',
    relativePath: 'param/NpcParam.parambnd',
    rows: [
      { table, rowId, rowIndex, fieldId: 'hp', value: 1500 },
      { table, rowId, rowIndex, fieldId: 'stamina', value: 300 }
    ],
    outerFileHash: fixtureHash('ws-right-outer'),
    childHash: fixtureHash('ws-right-child'),
    dataHash: fixtureHash('ws-right-data'),
    mtimeMs: sharedMtime
  };
  return {
    kind: 'FixtureWorkspacePair',
    left,
    right,
    sameLayout: true,
    differingFieldIds: ['hp', 'stamina']
  };
}

// ── Duplicate same-named children inside one BND ──

export interface FixtureBndChild {
  name: string;
  entryIndex: number;
  dataHash: string;
  size: number;
}

export interface FixtureDuplicateBndChildren {
  kind: 'FixtureDuplicateBndChildren';
  containerUri: string;
  sharedName: string;
  children: FixtureBndChild[];
  /** Discriminators that keep the two children distinct physical entities. */
  discriminators: Array<{ entryIndex: number; dataHash: string }>;
}

export function createFixtureDuplicateBndChildren(): FixtureDuplicateBndChildren {
  const sharedName = 'fixture/script/common.luainfo';
  return {
    kind: 'FixtureDuplicateBndChildren',
    containerUri: 'bnd4://fixture/script/script',
    sharedName,
    children: [
      { name: sharedName, entryIndex: 0, dataHash: fixtureHash('bnd-child-a'), size: 41 },
      { name: sharedName, entryIndex: 1, dataHash: fixtureHash('bnd-child-b'), size: 97 }
    ],
    discriminators: [
      { entryIndex: 0, dataHash: fixtureHash('bnd-child-a') },
      { entryIndex: 1, dataHash: fixtureHash('bnd-child-b') }
    ]
  };
}

// ── Two physical PARAM rows sharing the same rowId (different rowIndex) ──

export interface FixtureDuplicateParamRow {
  table: string;
  rowId: number;
  rowIndex: number;
  fieldId: string;
  value: number;
  dataHash: string;
}

export interface FixtureDuplicateParamRows {
  kind: 'FixtureDuplicateParamRows';
  table: string;
  rowId: number;
  rows: FixtureDuplicateParamRow[];
}

export function createFixtureDuplicateParamRows(): FixtureDuplicateParamRows {
  const table = 'FixtureItemLotParam';
  const rowId = 4200900;
  return {
    kind: 'FixtureDuplicateParamRows',
    table,
    rowId,
    rows: [
      {
        table,
        rowId,
        rowIndex: 11,
        fieldId: 'lotItemId01',
        value: 2000,
        dataHash: fixtureHash('dup-row-11')
      },
      {
        table,
        rowId,
        rowIndex: 27,
        fieldId: 'lotItemId01',
        value: 9001,
        dataHash: fixtureHash('dup-row-27')
      }
    ]
  };
}

// ── PARAM Ref metadata cases: Target(refType=1) hold / not-hold / sibling-unread / unparseable ──

export type FixtureParamRefCaseKind =
  | 'hold'
  | 'not_hold'
  | 'sibling_unread'
  | 'metadata_unparseable';

export interface FixtureParamRefCase {
  kindName: FixtureParamRefCaseKind;
  fieldId: string;
  /** Source field current value; null means unread. */
  sourceValue: number | null;
  conditionFieldId?: string;
  conditionValue?: number;
  /** Whether condition sibling is present in the read field set. */
  conditionSiblingPresent?: boolean;
  conditionSiblingValue?: number | null;
  /** Raw Refs metadata string (may be intentionally unparseable). */
  refsRaw: string;
  expectedCertainty: 'confirmed' | 'hypothesis' | 'none';
  expectedRelationCount: number;
  notes: string;
}

export interface FixtureParamRefCases {
  kind: 'FixtureParamRefCases';
  table: string;
  rowId: number;
  sourceUri: string;
  containerEntries: string[];
  cases: FixtureParamRefCase[];
}

export function createFixtureParamRefCases(): FixtureParamRefCases {
  // refType=1 style rule with condition: source field + sibling condition field.
  const hold: FixtureParamRefCase = {
    kindName: 'hold',
    fieldId: 'spEffectId0',
    sourceValue: 9030,
    conditionFieldId: 'spEffectType',
    conditionValue: 1,
    conditionSiblingPresent: true,
    conditionSiblingValue: 1,
    refsRaw: 'FixtureSpEffectParam(spEffectType=1)',
    expectedCertainty: 'confirmed',
    expectedRelationCount: 1,
    notes: 'Target refType=1 且条件兄弟字段已读且相等 → confirmed 边'
  };
  const notHold: FixtureParamRefCase = {
    kindName: 'not_hold',
    fieldId: 'spEffectId0',
    sourceValue: 9030,
    conditionFieldId: 'spEffectType',
    conditionValue: 1,
    conditionSiblingPresent: true,
    conditionSiblingValue: 0,
    refsRaw: 'FixtureSpEffectParam(spEffectType=1)',
    expectedCertainty: 'none',
    expectedRelationCount: 0,
    notes: '条件兄弟字段已读但值不匹配 → 规则不适用，不得产生边'
  };
  const siblingUnread: FixtureParamRefCase = {
    kindName: 'sibling_unread',
    fieldId: 'spEffectId0',
    sourceValue: 9030,
    conditionFieldId: 'spEffectType',
    conditionValue: 1,
    conditionSiblingPresent: false,
    conditionSiblingValue: null,
    refsRaw: 'FixtureSpEffectParam(spEffectType=1)',
    expectedCertainty: 'hypothesis',
    expectedRelationCount: 1,
    notes: '条件兄弟字段未读取 → 只能 hypothesis，不得 confirmed'
  };
  const unparseable: FixtureParamRefCase = {
    kindName: 'metadata_unparseable',
    fieldId: 'unknownRefField',
    sourceValue: 1,
    refsRaw: '<<<not-valid-refs-syntax>>>',
    expectedCertainty: 'none',
    expectedRelationCount: 0,
    notes: 'Refs 元数据不可解析 → 不得静默当作零引用'
  };
  return {
    kind: 'FixtureParamRefCases',
    table: 'FixtureCharaInitParam',
    rowId: 100000,
    sourceUri: 'gameparam://fixture/CharaInitParam',
    containerEntries: ['FixtureSpEffectParam', 'FixtureItemLotParam'],
    cases: [hold, notHold, siblingUnread, unparseable]
  };
}

// ── EMEVD pair: same eventId; one call passes target id via init parameters ──

export interface FixtureEmevdSide {
  label: string;
  sourceUri: string;
  eventId: number;
  /** Instruction-level literal args (no init-parameter indirection). */
  literalArgs: Array<{ argIndex: number; value: number }>;
  /** Init parameter table when the call passes target via init parameters. */
  initParameters?: Array<{ paramIndex: number; value: number }>;
  /** How the target id is expressed in the call instruction. */
  targetVia: 'literal' | 'init_parameter';
  outerFileHash: string;
  childHash: string;
}

export interface FixtureEmevdPair {
  kind: 'FixtureEmevdPair';
  sharedEventId: number;
  literalSide: FixtureEmevdSide;
  initParamSide: FixtureEmevdSide;
  /** The entity/param id both sides intend to target. */
  sharedTargetId: number;
}

export function createFixtureEmevdPair(): FixtureEmevdPair {
  const eventId = 1400100;
  const targetId = 1400800;
  return {
    kind: 'FixtureEmevdPair',
    sharedEventId: eventId,
    sharedTargetId: targetId,
    literalSide: {
      label: 'fixture-emevd-literal',
      sourceUri: 'emevd://fixture/m14/m14_00_00_00.emevd.dcx/event/1400100',
      eventId,
      literalArgs: [{ argIndex: 0, value: targetId }, { argIndex: 1, value: 0 }],
      targetVia: 'literal',
      outerFileHash: fixtureHash('emevd-literal-outer'),
      childHash: fixtureHash('emevd-literal-child')
    },
    initParamSide: {
      label: 'fixture-emevd-init-param',
      sourceUri: 'emevd://fixture/m14/m14_01_00_00.emevd.dcx/event/1400100',
      eventId,
      literalArgs: [{ argIndex: 0, value: 0 }],
      initParameters: [{ paramIndex: 0, value: targetId }],
      targetVia: 'init_parameter',
      outerFileHash: fixtureHash('emevd-init-outer'),
      childHash: fixtureHash('emevd-init-child')
    }
  };
}

// ── Map twin instances: two roles same model, only one has native NpcParam link ──

export interface FixtureMapTwinInstance {
  role: string;
  nativeObjectKey: string;
  modelId: number;
  npcParamRowId: number | null;
  hasNativeNpcParamLink: boolean;
}

export interface FixtureMapTwinInstances {
  kind: 'FixtureMapTwinInstances';
  sourceUri: string;
  modelId: number;
  instances: FixtureMapTwinInstance[];
}

export function createFixtureMapTwinInstances(): FixtureMapTwinInstances {
  const modelId = 2400100;
  return {
    kind: 'FixtureMapTwinInstances',
    sourceUri: 'msb://fixture/m14/m14_00_00_00.msb',
    modelId,
    instances: [
      {
        role: 'fixture-boss-role',
        nativeObjectKey: 'c0000_0001',
        modelId,
        npcParamRowId: 24001000,
        hasNativeNpcParamLink: true
      },
      {
        role: 'fixture-decoration-twin',
        nativeObjectKey: 'c0000_0002',
        modelId,
        npcParamRowId: null,
        hasNativeNpcParamLink: false
      }
    ]
  };
}

// ── Lua call cases: real / string fake / comment fake / local shadow / dynamic / bytecode ──

export type FixtureLuaCaseKind =
  | 'real_call'
  | 'string_fake'
  | 'comment_fake'
  | 'local_shadow'
  | 'dynamic_call'
  | 'bytecode_child_without_source';

export interface FixtureLuaCase {
  kindName: FixtureLuaCaseKind;
  childName: string;
  sourceText?: string;
  /** Byte present without source for bytecode children. */
  bytecode?: Buffer;
  expectedCallTargets: string[];
  expectedIsRealCall: boolean;
  notes: string;
}

export interface FixtureLuaCases {
  kind: 'FixtureLuaCases';
  containerUri: string;
  cases: FixtureLuaCase[];
}

export function createFixtureLuaCases(): FixtureLuaCases {
  return {
    kind: 'FixtureLuaCases',
    containerUri: 'luabnd://fixture/chr/c0000/luabnd',
    cases: [
      {
        kindName: 'real_call',
        childName: 'fixture_real.lua',
        sourceText:
          'local target = require("fixture_module")\n'
          + 'target.apply_buff(9030)\n',
        expectedCallTargets: ['fixture_module.apply_buff'],
        expectedIsRealCall: true,
        notes: '真实调用：require 后的标识符调用'
      },
      {
        kindName: 'string_fake',
        childName: 'fixture_string_fake.lua',
        sourceText:
          'local s = "target.apply_buff(9030)"\n'
          + 'print(s)\n',
        expectedCallTargets: [],
        expectedIsRealCall: false,
        notes: '字符串字面量中的调用样式不是调用'
      },
      {
        kindName: 'comment_fake',
        childName: 'fixture_comment_fake.lua',
        sourceText:
          '-- target.apply_buff(9030)\n'
          + 'local x = 1\n',
        expectedCallTargets: [],
        expectedIsRealCall: false,
        notes: '注释中的调用样式不是调用'
      },
      {
        kindName: 'local_shadow',
        childName: 'fixture_local_shadow.lua',
        sourceText:
          'local target = {}\n'
          + 'function target.apply_buff(id) return id end\n'
          + 'target.apply_buff(9030)\n',
        expectedCallTargets: ['local.target.apply_buff'],
        expectedIsRealCall: true,
        notes: '局部遮蔽：调用存在，但目标身份不是全局 fixture_module'
      },
      {
        kindName: 'dynamic_call',
        childName: 'fixture_dynamic.lua',
        sourceText:
          'local name = "apply_buff"\n'
          + 'local target = require("fixture_module")\n'
          + 'target[name](9030)\n',
        expectedCallTargets: [],
        expectedIsRealCall: false,
        notes: '动态索引调用：无静态目标，不得伪造成 confirmed 边'
      },
      {
        kindName: 'bytecode_child_without_source',
        childName: 'fixture_bytecode.lua',
        bytecode: Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x52, 0x00]),
        expectedCallTargets: [],
        expectedIsRealCall: false,
        notes: '仅有字节码、无源码的 child：不得声称已解析调用图'
      }
    ]
  };
}

// ── Oversized statement + CJK/emoji normal statement ──

export interface FixtureOversizedStatementBundle {
  kind: 'FixtureOversizedStatement';
  /** Statement text longer than 8KiB in UTF-8 bytes. */
  oversizedText: string;
  oversizedByteLength: number;
  /** Normal CJK + emoji statement under budget. */
  normalText: string;
  normalByteLength: number;
  budgetBytes: number;
}

export function createFixtureOversizedStatement(): FixtureOversizedStatementBundle {
  const budgetBytes = 8192;
  // 9KiB+ of repeated ASCII so byte length is deterministic and > budget.
  const padUnit = 'FIXTURE_OVERSIZE_STMT_';
  const repeat = Math.ceil((budgetBytes + 1024) / padUnit.length);
  const oversizedText = padUnit.repeat(repeat);
  const oversizedByteLength = Buffer.byteLength(oversizedText, 'utf8');
  const normalText = 'Fixture 正常语句：将鬼庭形部的 HP 调高 ✅🐉（含表情与 CJK）';
  return {
    kind: 'FixtureOversizedStatement',
    oversizedText,
    oversizedByteLength,
    normalText,
    normalByteLength: Buffer.byteLength(normalText, 'utf8'),
    budgetBytes
  };
}

// ── Versions H0/H1/H2 with real sha256 outer/child/data hashes ──

export interface FixtureVersionSnapshot {
  label: 'H0' | 'H1' | 'H2';
  outerFileHash: string;
  childHash: string;
  dataHash: string;
  mtimeMs: number;
  size: number;
  generation: number;
  readerSchema: string;
  metadataSchema: string;
  description: string;
}

export interface FixtureVersions {
  kind: 'FixtureVersions';
  /** Baseline observation. */
  H0: FixtureVersionSnapshot;
  /** Same mtime, content changed — mtime alone must not prove freshness. */
  H1SameMtimeContentChange: FixtureVersionSnapshot;
  /** Metadata/schema change without data change. */
  H2MetadataChange: FixtureVersionSnapshot;
  /** Mid-read source change: outer hash after read differs from proof version. */
  midReadSourceChange: {
    versionAtRead: FixtureVersionSnapshot;
    versionAtWrite: FixtureVersionSnapshot;
  };
  /** Late async result arriving after a newer version is already authoritative. */
  lateAsyncOldResult: {
    staleResultVersion: FixtureVersionSnapshot;
    currentAuthoritativeVersion: FixtureVersionSnapshot;
  };
}

export function createFixtureVersions(): FixtureVersions {
  const baseMtime = 1_700_000_000_000;
  const baseSize = 4096;
  const H0: FixtureVersionSnapshot = {
    label: 'H0',
    outerFileHash: fixtureHash('ver-h0-outer'),
    childHash: fixtureHash('ver-h0-child'),
    dataHash: fixtureHash('ver-h0-data'),
    mtimeMs: baseMtime,
    size: baseSize,
    generation: 0,
    readerSchema: 'fixture-reader@1',
    metadataSchema: 'fixture-meta@1',
    description: '基线版本：完整 outer/child/data 真实 sha256'
  };
  // Same mtime + same size, different content hashes — proves mtime is not authority.
  const H1SameMtimeContentChange: FixtureVersionSnapshot = {
    label: 'H1',
    outerFileHash: fixtureHash('ver-h1-outer'),
    childHash: fixtureHash('ver-h1-child'),
    dataHash: fixtureHash('ver-h1-data'),
    mtimeMs: baseMtime,
    size: baseSize,
    generation: 1,
    readerSchema: 'fixture-reader@1',
    metadataSchema: 'fixture-meta@1',
    description: '同 mtime 内容变化：hash 变了，mtime 仍是基线值'
  };
  const H2MetadataChange: FixtureVersionSnapshot = {
    label: 'H2',
    outerFileHash: H0.outerFileHash,
    childHash: H0.childHash,
    dataHash: H0.dataHash,
    mtimeMs: baseMtime,
    size: baseSize,
    generation: 2,
    readerSchema: 'fixture-reader@2',
    metadataSchema: 'fixture-meta@2',
    description: '内容 hash 不变，仅 reader/metadata schema 变化'
  };
  return {
    kind: 'FixtureVersions',
    H0,
    H1SameMtimeContentChange,
    H2MetadataChange,
    midReadSourceChange: {
      versionAtRead: H0,
      versionAtWrite: {
        ...H0,
        outerFileHash: fixtureHash('ver-mid-read-write-outer'),
        childHash: fixtureHash('ver-mid-read-write-child'),
        dataHash: fixtureHash('ver-mid-read-write-data'),
        generation: 3,
        description: '读取过程中源已变化，写入时的版本与证明版本不一致'
      }
    },
    lateAsyncOldResult: {
      staleResultVersion: H0,
      currentAuthoritativeVersion: {
        ...H1SameMtimeContentChange,
        generation: 4,
        description: '当前权威版本已前进；迟到的 H0 结果必须被丢弃'
      }
    }
  };
}

// ── Native port counters + in-memory ports ──

export interface FixtureNativePortCounters {
  nativeParseCount: number;
  childExtractionCount: number;
  containerInventoryCount: number;
  coalescedWaiterCount: number;
  freshVerificationReadCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  eventReadCount: number;
  scriptReadCount: number;
  paramFieldReadCount: number;
  listContainerCount: number;
  resolveEntityCount: number;
}

export function createFixtureNativePortCounters(): FixtureNativePortCounters {
  return {
    nativeParseCount: 0,
    childExtractionCount: 0,
    containerInventoryCount: 0,
    coalescedWaiterCount: 0,
    freshVerificationReadCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    eventReadCount: 0,
    scriptReadCount: 0,
    paramFieldReadCount: 0,
    listContainerCount: 0,
    resolveEntityCount: 0
  };
}

export interface FixtureNativePorts {
  counters: FixtureNativePortCounters;
  snapshotCounters: {
    nativeParseCount: number;
    childExtractionCount: number;
    containerInventoryCount: number;
    coalescedWaiterCount: number;
    cacheHitCount: number;
    cacheMissCount: number;
    freshVerificationReadCount: number;
  };
  /** Provider-facing ports; each increments counters on the port object. */
  providerPorts: {
    readEmevdDocument: (input: unknown) => Promise<unknown>;
    readScriptText: (input: unknown) => Promise<unknown>;
    readParamFields: (input: unknown) => Promise<unknown>;
    listContainerMembers: (input: unknown) => Promise<unknown>;
    resolveEntity: (input: unknown) => Promise<unknown>;
  };
  snapshot: {
    /** Loader that increments nativeParseCount; simulates cold native parse. */
    parseLoader: <T>(produce: () => T | Promise<T>) => Promise<T>;
    noteCacheHit: () => void;
    noteCacheMiss: () => void;
    noteCoalescedWaiter: () => void;
    noteFreshVerificationRead: () => void;
    noteChildExtraction: () => void;
    noteContainerInventory: () => void;
  };
  reset: () => void;
}

/**
 * In-memory ports with counters owned by the port object.
 * Tests read counters from here; they must not invent expected hit counts
 * inside production modules.
 */
export function createFixtureNativePorts(options?: {
  onEventRead?: (input: unknown) => unknown;
  onScriptRead?: (input: unknown) => unknown;
  onParamFieldRead?: (input: unknown) => unknown;
  onListContainer?: (input: unknown) => unknown;
  onResolveEntity?: (input: unknown) => unknown;
}): FixtureNativePorts {
  const counters = createFixtureNativePortCounters();
  const snapshotCounters = {
    get nativeParseCount() { return counters.nativeParseCount; },
    get childExtractionCount() { return counters.childExtractionCount; },
    get containerInventoryCount() { return counters.containerInventoryCount; },
    get coalescedWaiterCount() { return counters.coalescedWaiterCount; },
    get cacheHitCount() { return counters.cacheHitCount; },
    get cacheMissCount() { return counters.cacheMissCount; },
    get freshVerificationReadCount() { return counters.freshVerificationReadCount; }
  };

  const providerPorts: FixtureNativePorts['providerPorts'] = {
    async readEmevdDocument(input) {
      counters.eventReadCount += 1;
      return options?.onEventRead?.(input) ?? { ok: true, data: { kind: 'fixture-emevd', input } };
    },
    async readScriptText(input) {
      counters.scriptReadCount += 1;
      return options?.onScriptRead?.(input) ?? { ok: true, data: { kind: 'fixture-script', input } };
    },
    async readParamFields(input) {
      counters.paramFieldReadCount += 1;
      return options?.onParamFieldRead?.(input) ?? { ok: true, data: { kind: 'fixture-param-fields', input } };
    },
    async listContainerMembers(input) {
      counters.listContainerCount += 1;
      return options?.onListContainer?.(input) ?? { ok: true, data: { kind: 'fixture-container', input } };
    },
    async resolveEntity(input) {
      counters.resolveEntityCount += 1;
      return options?.onResolveEntity?.(input) ?? { ok: true, data: { kind: 'fixture-resolve', input } };
    }
  };

  return {
    counters,
    snapshotCounters,
    providerPorts,
    snapshot: {
      async parseLoader(produce) {
        counters.nativeParseCount += 1;
        return produce();
      },
      noteCacheHit() { counters.cacheHitCount += 1; },
      noteCacheMiss() { counters.cacheMissCount += 1; },
      noteCoalescedWaiter() { counters.coalescedWaiterCount += 1; },
      noteFreshVerificationRead() { counters.freshVerificationReadCount += 1; },
      noteChildExtraction() { counters.childExtractionCount += 1; },
      noteContainerInventory() { counters.containerInventoryCount += 1; }
    },
    reset() {
      const fresh = createFixtureNativePortCounters();
      (Object.keys(fresh) as Array<keyof FixtureNativePortCounters>).forEach((key) => {
        counters[key] = fresh[key];
      });
    }
  };
}

/** Identity helper aligned with NativeSourceIdentity shape (fixture-only). */
export function fixtureNativeIdentity(input: {
  workspaceId: string;
  outerId: string;
  childChain: string[];
  domain: 'param' | 'fmg' | 'emevd' | 'script' | 'map' | 'tae';
  namespace: string;
  objectKey: string;
}): {
  workspaceId: string;
  outerId: string;
  childChain: string[];
  domain: 'param' | 'fmg' | 'emevd' | 'script' | 'map' | 'tae';
  namespace: string;
  objectKey: string;
} {
  return { ...input, childChain: [...input.childChain] };
}

export const FIXTURE_CONSTANTS = Object.freeze({
  pageBudgetBytes: 8192,
  fixturePrefix: 'Fixture',
  hashAlgorithm: 'sha256'
});
