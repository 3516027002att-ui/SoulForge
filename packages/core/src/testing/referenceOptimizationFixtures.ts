/**
 * Regression fixtures for the reference-query / read-proof overhaul (T01).
 *
 * Fixtures control ONLY the lowest-level native read/write port inputs and
 * outputs. Identity resolution, graph building, page projection, proof
 * decisions, permission decisions and the CLI dispatcher run as production
 * code on top of these fixtures.
 *
 * All names use the `Fixture*` prefix so test data can never be mistaken for
 * game facts. Version labels H0/H1/H2 are opaque tags; every sourceHash,
 * outerFileHash and dataHash is a real SHA-256 over the fixture bytes.
 */
import { createHash } from 'node:crypto';
import { parseParamFieldRefs } from '@soulforge/shared';
import type {
  EventExport,
  MapEntitySymbol,
  MsgExport,
  ParamExport,
  ScriptExport,
  SymbolBundle
} from '@soulforge/shared';

export function fixtureHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/* ------------------------------------------------------------------ */
/* H0/H1/H2 version bytes (real hashes, same mtime variants)           */
/* ------------------------------------------------------------------ */

export const FIXTURE_VERSION_BYTES: Record<'H0' | 'H1' | 'H2', Buffer> = {
  H0: Buffer.from('fixture-source-v0', 'utf8'),
  H1: Buffer.from('fixture-source-v1', 'utf8'),
  H2: Buffer.from('fixture-source-v2', 'utf8')
};

export const FIXTURE_VERSION_HASHES: Record<'H0' | 'H1' | 'H2', string> = {
  H0: fixtureHash(FIXTURE_VERSION_BYTES.H0),
  H1: fixtureHash(FIXTURE_VERSION_BYTES.H1),
  H2: fixtureHash(FIXTURE_VERSION_BYTES.H2)
};

/* ------------------------------------------------------------------ */
/* Instrumented native port                                            */
/* ------------------------------------------------------------------ */

export interface NativeCallCounters {
  cliHostStarts: number;
  workspaceOpenCount: number;
  bridgeProcessStarts: number;
  containerInventoryCount: number;
  childExtractionCount: number;
  nativeParseCount: number;
  fullDocumentAssemblyCount: number;
  relationShardBuildCount: number;
  coalescedWaiterCount: number;
  freshVerificationReadCount: number;
  modelToolCalls: number;
  writerCalls: number;
}

export function newFixtureCounters(): NativeCallCounters {
  return {
    cliHostStarts: 0, workspaceOpenCount: 0, bridgeProcessStarts: 0,
    containerInventoryCount: 0, childExtractionCount: 0, nativeParseCount: 0,
    fullDocumentAssemblyCount: 0, relationShardBuildCount: 0,
    coalescedWaiterCount: 0, freshVerificationReadCount: 0,
    modelToolCalls: 0, writerCalls: 0
  };
}

export interface FixtureChild {
  entryIndex: number;
  entryName: string;
  payload: Buffer;
  /** 'source' | 'bytecode' | 'catalog-only' — never collapse these. */
  contentKind: 'source' | 'bytecode' | 'catalog-only';
}

export interface FixtureOuter {
  sourceUri: string;
  outerBytes: Buffer;
  mtimeMs: number;
  children: FixtureChild[];
  /** Parsed-document payload; providers must go through parse(), not read this. */
  document?: SymbolBundle;
}

/**
 * Lowest-level native port double. Every method increments its own counter so
 * performance smokes measure real call counts instead of hand-tallied
 * expectations. `swapOuter` / `swapChild` simulate external edits (including
 * same-mtime content changes for V01).
 */
export class FixtureNativeBackend {
  readonly counters: NativeCallCounters = newFixtureCounters();
  private readonly outers = new Map<string, FixtureOuter>();
  private readonly metadataSchemas = new Map<string, string>();
  /** When set, the next parse() of this source throws once (failure injection). */
  private readonly failNextParse = new Set<string>();
  /** In-flight parse join registry the backend itself never dedups — the cache layer must. */
  public parseJoinObserved = false;

  addOuter(outer: FixtureOuter): void {
    this.outers.set(outer.sourceUri, outer);
  }

  getOuter(sourceUri: string): FixtureOuter | undefined {
    return this.outers.get(sourceUri);
  }

  setMetadataSchema(sourceUri: string, schema: string): void {
    this.metadataSchemas.set(sourceUri, schema);
  }

  metadataSchema(sourceUri: string): string | undefined {
    return this.metadataSchemas.get(sourceUri);
  }

  /** Simulate an external edit; pass keepMtime=true for the V01 case. */
  swapOuter(sourceUri: string, outerBytes: Buffer, options: { keepMtime?: boolean } = {}): void {
    const outer = this.outers.get(sourceUri);
    if (!outer) throw new Error(`FixtureNativeBackend: unknown source ${sourceUri}`);
    outer.outerBytes = outerBytes;
    if (!options.keepMtime) outer.mtimeMs += 1;
  }

  swapChild(sourceUri: string, entryIndex: number, payload: Buffer): void {
    const outer = this.outers.get(sourceUri);
    const child = outer?.children.find((item) => item.entryIndex === entryIndex);
    if (!child) throw new Error(`FixtureNativeBackend: unknown child ${sourceUri}[${entryIndex}]`);
    child.payload = payload;
  }

  failNext(sourceUri: string): void {
    this.failNextParse.add(sourceUri);
  }

  inventory(sourceUri: string): Array<{ entryIndex: number; entryName: string; contentKind: string }> {
    this.counters.containerInventoryCount += 1;
    const outer = this.outers.get(sourceUri);
    if (!outer) throw new Error(`FixtureNativeBackend: unknown source ${sourceUri}`);
    return outer.children.map((child) => ({
      entryIndex: child.entryIndex, entryName: child.entryName, contentKind: child.contentKind
    }));
  }

  extractChild(sourceUri: string, entryIndex: number): Buffer {
    this.counters.childExtractionCount += 1;
    const child = this.outers.get(sourceUri)?.children.find((item) => item.entryIndex === entryIndex);
    if (!child) throw new Error(`FixtureNativeBackend: unknown child ${sourceUri}[${entryIndex}]`);
    if (child.contentKind === 'bytecode') {
      throw new Error(`FixtureNativeBackend: child ${sourceUri}[${entryIndex}] is bytecode without original text`);
    }
    return child.payload;
  }

  parse(sourceUri: string): SymbolBundle {
    this.counters.nativeParseCount += 1;
    if (this.failNextParse.delete(sourceUri)) {
      throw new Error(`FixtureNativeBackend: injected parse failure for ${sourceUri}`);
    }
    const outer = this.outers.get(sourceUri);
    if (!outer?.document) throw new Error(`FixtureNativeBackend: no parsed document for ${sourceUri}`);
    return outer.document;
  }

  assembleFullDocument(sourceUri: string): SymbolBundle {
    this.counters.fullDocumentAssemblyCount += 1;
    return this.parse(sourceUri);
  }

  buildRelationShard(sourceUri: string): void {
    this.counters.relationShardBuildCount += 1;
    void sourceUri;
  }

  freshVerificationRead(sourceUri: string): void {
    this.counters.freshVerificationReadCount += 1;
    void sourceUri;
  }

  write(sourceUri: string, bytes: Buffer): void {
    this.counters.writerCalls += 1;
    const outer = this.outers.get(sourceUri);
    if (!outer) throw new Error(`FixtureNativeBackend: unknown write target ${sourceUri}`);
    outer.outerBytes = bytes;
  }
}

/* ------------------------------------------------------------------ */
/* Shared fixture constants                                            */
/* ------------------------------------------------------------------ */

export const FIXTURE_WORKSPACE_A = 'fixture-workspace-A';
export const FIXTURE_WORKSPACE_B = 'fixture-workspace-B';
/** Same relative path in both workspaces (I01: identical path must not merge). */
export const FIXTURE_SHARED_RELATIVE_PATH = 'Event/Param/ParamGame/GameParam.parambnd.dcx';

export const FIXTURE_NPC_PARAM = 'NpcParam';
export const FIXTURE_TARGET_ROW_ID = 50800000;
export const FIXTURE_REF_FIELD_ID = 'ThinkParamId';
export const FIXTURE_THINK_PARAM = 'ThinkParam';
export const FIXTURE_EVENT_ID = 6000;

function paramUri(workspace: string, table: string, rowId: number): string {
  return `workspace://${workspace}/mods/${FIXTURE_SHARED_RELATIVE_PATH}#${table}/${rowId}`;
}

function outerHash(tag: string): string {
  return fixtureHash(`outer-container:${tag}`);
}

/* ------------------------------------------------------------------ */
/* 1. Two workspaces, same relative path/table/rowId, different values */
/* ------------------------------------------------------------------ */

export function buildWorkspacePairBundles(): { bundleA: SymbolBundle; bundleB: SymbolBundle } {
  const make = (workspace: string, hp: number, outerTag: string): SymbolBundle => ({
    params: [{
      paramName: FIXTURE_NPC_PARAM,
      sourceUri: `workspace://${workspace}/mods/${FIXTURE_SHARED_RELATIVE_PATH}`,
      entryIndex: 0, entryName: `${FIXTURE_NPC_PARAM}.param`,
      outerFileHash: outerHash(outerTag),
      rows: [{
        uri: paramUri(workspace, FIXTURE_NPC_PARAM, FIXTURE_TARGET_ROW_ID),
        sourceUri: `workspace://${workspace}/mods/${FIXTURE_SHARED_RELATIVE_PATH}`,
        paramName: FIXTURE_NPC_PARAM, entryName: `${FIXTURE_NPC_PARAM}.param`, entryIndex: 0,
        rowId: FIXTURE_TARGET_ROW_ID, rowIndex: 0,
        dataHash: fixtureHash(`npc-row:${workspace}:${hp}`),
        outerFileHash: outerHash(outerTag),
        fields: [
          { fieldId: 'hp', name: 'hp', type: 's32', value: hp },
          { fieldId: FIXTURE_REF_FIELD_ID, name: FIXTURE_REF_FIELD_ID, type: 's32', value: 700 }
        ]
      }]
    } satisfies ParamExport]
  });
  return { bundleA: make(FIXTURE_WORKSPACE_A, 100, 'A'), bundleB: make(FIXTURE_WORKSPACE_B, 999, 'B') };
}

/* ------------------------------------------------------------------ */
/* 2. Duplicate child names + duplicate physical rows                  */
/* ------------------------------------------------------------------ */

export function buildDuplicateIdentityBundle(): SymbolBundle {
  const sourceUri = `workspace://${FIXTURE_WORKSPACE_A}/mods/dup/Dup.parambnd.dcx`;
  return {
    params: [
      {
        paramName: 'DupA', sourceUri, entryIndex: 3, entryName: 'Dup.param',
        outerFileHash: outerHash('dup'),
        rows: [{
          uri: `${sourceUri}#DupA/10`, sourceUri, paramName: 'DupA',
          entryName: 'Dup.param', entryIndex: 3, rowId: 10, rowIndex: 0,
          dataHash: fixtureHash('dup-row-10-index0'),
          fields: [{ fieldId: 'v', name: 'v', value: 'first-physical-row' }]
        }, {
          uri: `${sourceUri}#DupA/10@1`, sourceUri, paramName: 'DupA',
          entryName: 'Dup.param', entryIndex: 3, rowId: 10, rowIndex: 1,
          dataHash: fixtureHash('dup-row-10-index1'),
          fields: [{ fieldId: 'v', name: 'v', value: 'second-physical-row' }]
        }]
      },
      {
        paramName: 'DupB', sourceUri, entryIndex: 7, entryName: 'Dup.param',
        outerFileHash: outerHash('dup'),
        rows: [{
          uri: `${sourceUri}#DupB/10`, sourceUri, paramName: 'DupB',
          entryName: 'Dup.param', entryIndex: 7, rowId: 10, rowIndex: 0,
          dataHash: fixtureHash('dupb-row-10'),
          fields: [{ fieldId: 'v', name: 'v', value: 'other-duplicate-entry' }]
        }]
      }
    ]
  };
}

/* ------------------------------------------------------------------ */
/* 3. Conditional refs: holds / not-holds / sibling-unread / unparseable */
/* ------------------------------------------------------------------ */

export const FIXTURE_REFS_SYNTAX = 'Bullet(refType=1),AtkParam_Npc(refType=0),SpEffectParam(refType=2)';
export const FIXTURE_REFS_UNKNOWN = 'Bullet(refType=1),NotATarget!!(x=)';

export interface FixtureConditionalRefRow {
  rowId: number;
  refId: number;
  refType: number | null;
  expect: 'hit' | 'miss' | 'unresolved-condition' | 'rejected-syntax';
}

export const FIXTURE_CONDITIONAL_ROWS: FixtureConditionalRefRow[] = [
  { rowId: 1, refId: 400, refType: 1, expect: 'hit' },
  { rowId: 2, refId: 400, refType: 0, expect: 'miss' },
  { rowId: 3, refId: 400, refType: null, expect: 'unresolved-condition' },
  { rowId: 4, refId: 400, refType: 1, expect: 'rejected-syntax' }
];

export function buildConditionalRefBundle(): SymbolBundle {
  const sourceUri = `workspace://${FIXTURE_WORKSPACE_A}/mods/cond/Cond.parambnd.dcx`;
  const parsedGood = parseParamFieldRefs(FIXTURE_REFS_SYNTAX);
  const parsedBad = parseParamFieldRefs(FIXTURE_REFS_UNKNOWN);
  const rows = FIXTURE_CONDITIONAL_ROWS.map((row) => {
    const parsed = row.expect === 'rejected-syntax' ? parsedBad : parsedGood;
    const fields = [
      {
        fieldId: 'refId', name: 'refId', type: 's32', value: row.refId,
        refs: parsed.targets,
        ...(parsed.rejected.length > 0 ? { refsRejected: parsed.rejected } : {}),
        refsProvenance: 'trusted-metadata' as const
      },
      ...(row.refType === null
        ? []
        : [{ fieldId: 'refType', name: 'refType', type: 'u8', value: row.refType }])
    ];
    return {
      uri: `${sourceUri}#BehaviorParam/${row.rowId}`, sourceUri, paramName: 'BehaviorParam',
      entryName: 'BehaviorParam.param', entryIndex: 1, rowId: row.rowId, rowIndex: row.rowId - 1,
      dataHash: fixtureHash(`cond-row-${row.rowId}`),
      fields
    };
  });
  return {
    params: [{
      paramName: 'BehaviorParam', sourceUri, entryIndex: 1, entryName: 'BehaviorParam.param',
      outerFileHash: outerHash('cond'), rows
    }, {
      paramName: 'Bullet', sourceUri, entryIndex: 2, entryName: 'Bullet.param',
      outerFileHash: outerHash('cond'),
      rows: [{
        uri: `${sourceUri}#Bullet/400`, sourceUri, paramName: 'Bullet',
        entryName: 'Bullet.param', entryIndex: 2, rowId: 400, rowIndex: 0,
        dataHash: fixtureHash('bullet-400'), fields: [{ fieldId: 'life', name: 'life', value: 3 }]
      }]
    }]
  };
}

/* ------------------------------------------------------------------ */
/* 4. Same eventId in two EMEVD files + init-call parameter passing    */
/* ------------------------------------------------------------------ */

export const FIXTURE_EMEVD_FILE_X = `workspace://${FIXTURE_WORKSPACE_A}/mods/event/x/m11_00_00_00.emevd.dcx`;
export const FIXTURE_EMEVD_FILE_Y = `workspace://${FIXTURE_WORKSPACE_A}/mods/event/y/m11_01_00_00.emevd.dcx`;
/** The ID one event passes to the other through an initialization-call argument. */
export const FIXTURE_PASSED_TARGET_ID = 6000;

export function buildEmevdCrossFileBundle(): SymbolBundle {
  const eventXUri = `${FIXTURE_EMEVD_FILE_X}#event/${FIXTURE_EVENT_ID}`;
  const eventYUri = `${FIXTURE_EMEVD_FILE_Y}#event/${FIXTURE_EVENT_ID}`;
  return {
    events: [
      {
        mapId: 'm11_00_00_00', sourceHash: fixtureHash(FIXTURE_EMEVD_FILE_X),
        outerFileHash: outerHash('emevd-x'),
        events: [{
          uri: eventXUri, sourceUri: FIXTURE_EMEVD_FILE_X, mapId: 'm11_00_00_00',
          eventId: FIXTURE_EVENT_ID, outerFileHash: outerHash('emevd-x'),
          instructions: [{
            uri: `${eventXUri}#instruction/0`, index: 0, name: 'InitializeEvent', bank: 1, id: 11,
            byteRange: [64, 96],
            args: [
              { name: 'eventId', value: FIXTURE_PASSED_TARGET_ID, argIndex: 0, role: 'eventId', roleSource: 'registry' },
              { name: 'talkId', value: 900, argIndex: 1, role: 'paramId', paramName: FIXTURE_THINK_PARAM, roleSource: 'registry' }
            ]
          }]
        }]
      },
      {
        mapId: 'm11_01_00_00', sourceHash: fixtureHash(FIXTURE_EMEVD_FILE_Y),
        outerFileHash: outerHash('emevd-y'),
        events: [{
          uri: eventYUri, sourceUri: FIXTURE_EMEVD_FILE_Y, mapId: 'm11_01_00_00',
          eventId: FIXTURE_EVENT_ID, outerFileHash: outerHash('emevd-y'),
          instructions: [{
            uri: `${eventYUri}#instruction/0`, index: 0, name: 'SetTalkFlag', bank: 2, id: 40,
            byteRange: [32, 56],
            args: [{ name: 'flagId', value: 12345, argIndex: 0, role: 'flag', roleSource: 'registry' }]
          }]
        }]
      }
    ]
  };
}

/* ------------------------------------------------------------------ */
/* 5. Two map instances share a model; one has the native link         */
/* ------------------------------------------------------------------ */

export const FIXTURE_MAP_SOURCE = `workspace://${FIXTURE_WORKSPACE_A}/mods/map/m11_02_00_00/m11_02_00_00.msb.dcx`;
export const FIXTURE_SHARED_MODEL = 'c1050.tai';

export function buildMapInstanceBundle(): SymbolBundle {
  const entity = (name: string, key: string, npcParamRowId: number | undefined): MapEntitySymbol => ({
    uri: `${FIXTURE_MAP_SOURCE}#entity/${key}`, sourceUri: FIXTURE_MAP_SOURCE, mapId: 'm11_02_00_00',
    entityId: 300, internalEntryId: Number(key), name,
    kind: 'character', model: FIXTURE_SHARED_MODEL,
    position: [10, 0, 20],
    outerFileHash: outerHash('msb'),
    ...(npcParamRowId === undefined ? {} : { raw: { npcParamRowId } })
  });
  return {
    maps: [{
      mapId: 'm11_02_00_00', sourceHash: fixtureHash(FIXTURE_MAP_SOURCE), outerFileHash: outerHash('msb'),
      entities: [
        entity('c1050_0000', '4194304', FIXTURE_TARGET_ROW_ID),
        entity('c1050_0100', '4194305', undefined)
      ],
      regions: []
    }]
  };
}

/* ------------------------------------------------------------------ */
/* 6. Lua child: real/fake calls, shadowing, dynamic; bytecode child   */
/* ------------------------------------------------------------------ */

export const FIXTURE_LUABND_SOURCE = `workspace://${FIXTURE_WORKSPACE_A}/mods/script/m11_00_00_00.luabnd.dcx`;
export const FIXTURE_LUA_ENTRY_NAME = 'm11_00_00_00.lua';
export const FIXTURE_BYTECODE_ENTRY_NAME = 'm11_00_00_00.lua.bc';

export const FIXTURE_LUA_TEXT = [
  '-- SetTalkFlag(777, 1) fake call inside a line comment',
  '--[[ SetTalkFlag(778, 1) fake call inside a long comment ]]',
  'local function SetTalkFlag(a, b) return a + b end',
  'SetTalkFlag(10010, 1)',
  'RequestAsset("c1050_ai", 1)',
  'local msg = "SetTalkFlag(99999, 1)"',
  'SetTalkFlag(msg, 1)',
  'SetTalkFlag(10020, 1)'
].join('\n');

export function buildScriptBundle(): SymbolBundle {
  return {
    scripts: [{
      sourceUri: FIXTURE_LUABND_SOURCE, containerKind: 'luabnd',
      outerFileHash: outerHash('luabnd'), catalogComplete: true,
      scripts: [
        {
          uri: `${FIXTURE_LUABND_SOURCE}!/${FIXTURE_LUA_ENTRY_NAME}`,
          sourceUri: FIXTURE_LUABND_SOURCE, childChain: [FIXTURE_LUA_ENTRY_NAME],
          entryIndex: 0, entryName: FIXTURE_LUA_ENTRY_NAME, contentKind: 'source',
          sourceText: FIXTURE_LUA_TEXT,
          sourceHash: fixtureHash(FIXTURE_LUA_TEXT), outerFileHash: outerHash('luabnd')
        },
        {
          uri: `${FIXTURE_LUABND_SOURCE}!/${FIXTURE_BYTECODE_ENTRY_NAME}`,
          sourceUri: FIXTURE_LUABND_SOURCE, childChain: [FIXTURE_BYTECODE_ENTRY_NAME],
          entryIndex: 1, entryName: FIXTURE_BYTECODE_ENTRY_NAME, contentKind: 'bytecode',
          encodingDiagnostics: ['bytecode child provides no original text'],
          outerFileHash: outerHash('luabnd')
        }
      ]
    } satisfies ScriptExport]
  };
}

/* ------------------------------------------------------------------ */
/* 7. Oversize + CJK/emoji statements (UTF-8 budget)                   */
/* ------------------------------------------------------------------ */

export const FIXTURE_LONG_STATEMENT = `RequestAsset("${'长资产路径/'.repeat(200)}c1050", 1)`;
export const FIXTURE_CJK_EMOJI_STATEMENT = 'ShowMessage("篝火🔥已点燃 —— 请确认", 42)';

/* ------------------------------------------------------------------ */
/* Scenario A composite: one page with param/emevd/lua/map relations   */
/* ------------------------------------------------------------------ */

export function buildScenarioABundle(): SymbolBundle {
  const pair = buildWorkspacePairBundles();
  const cond = buildConditionalRefBundle();
  const emevd = buildEmevdCrossFileBundle();
  const map = buildMapInstanceBundle();
  const script = buildScriptBundle();
  const fmg: MsgExport = {
    category: 'ItemName', sourceHash: fixtureHash('msgbnd'),
    outerFileHash: outerHash('fmg'),
    entries: [{
      uri: `workspace://${FIXTURE_WORKSPACE_A}/mods/fmg/msgbnd.fmg#ItemName/200`,
      sourceUri: `workspace://${FIXTURE_WORKSPACE_A}/mods/fmg/msgbnd.fmg`,
      category: 'ItemName', textId: 200, text: '修复虫',
      outerFileHash: outerHash('fmg')
    }]
  };
  return {
    params: [...(pair.bundleA.params ?? []), ...(cond.params ?? [])],
    events: emevd.events ?? [],
    maps: map.maps ?? [],
    scripts: script.scripts ?? [],
    msgs: [fmg]
  };
}

/** Every fixture source in scenario A carries a distinct outer hash (§6). */
export function scenarioAOuterHashes(bundle: SymbolBundle): string[] {
  const hashes = new Set<string>();
  for (const exportList of [bundle.params, bundle.events, bundle.maps, bundle.scripts, bundle.msgs] as Array<Array<{ outerFileHash?: string }> | undefined>) {
    for (const item of exportList ?? []) {
      if (item.outerFileHash) hashes.add(item.outerFileHash);
    }
  }
  return [...hashes];
}

/* ------------------------------------------------------------------ */
/* Event export helper for backend-hosted documents                    */
/* ------------------------------------------------------------------ */

export function fixtureEventExport(sourceUri: string, outerTag: string, events: EventExport['events']): EventExport {
  return { sourceHash: fixtureHash(sourceUri), outerFileHash: outerHash(outerTag), events };
}

export function fixtureParamExport(sourceUri: string, outerTag: string, rows: ParamExport['rows'], entryName: string, entryIndex: number): ParamExport {
  return {
    paramName: entryName.replace(/\.param$/u, ''), sourceUri, entryIndex, entryName,
    outerFileHash: outerHash(outerTag), rows
  };
}


