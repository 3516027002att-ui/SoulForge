/**
 * ChrLinkageResolver:
 *
 * Lightweight, on-demand deterministic cross-resource linkage resolver.
 * Bridges NpcParam rowId -> Character model ID (cXXXX) -> Map MSB -> Event EMEVD (Boss UI/Lifecycle) -> Lua AI scripts.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runBridge } from '../bridge/runBridge.js';
import { readFullEmevdDocumentViaBridge } from '../editing/emevdFullDocument.js';
import { createCoverageState, type CoverageState } from '../indexing/coverageState.js';

export interface ChrMapLink {
  mapFile: string;
  mapId: string;
  partName: string;
  eventFile: string;
}

export interface ChrBossEventLink {
  mapFile: string;
  eventFile: string;
  eventId: number;
  role?: string;
  instructionName: string;
  keyInstructions?: string[];
  description: string;
}

export interface ChrLinkageEdge {
  ruleId: string;
  fromUri: string;
  toUri: string;
  sourceProperty: string;
  targetNamespace: string;
  sourceSnapshot: {
    sourceUri: string;
    sourceRevision?: number;
  };
  targetConfirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

export interface ChrReadPlanStep {
  stepId: string;
  target: string;
  reason: string;
  requiredForMutation: boolean;
}

export interface ChrLinkageResult {
  characterId: string;
  npcParamId: number;
  maps: ChrMapLink[];
  associatedBossEvents: ChrBossEventLink[];
  scripts: string[];
  coverage: CoverageState;
  coverageByDomain: CoverageState[];
  verifiedEdges: ChrLinkageEdge[];
  blockedReasons: string[];
  nextReadPlan: ChrReadPlanStep[];
}

interface MsbCacheEntry {
  mtimeMs: number;
  parts: Array<{ name: string; entityId?: number }>;
}

interface EmevdParsedEvent {
  eventId: number;
  instructions: Array<{ bank: number; id: number }>;
}

interface EmevdCacheEntry {
  mtimeMs: number;
  events: EmevdParsedEvent[];
}

const msbCache = new Map<string, MsbCacheEntry>();
const emevdCache = new Map<string, EmevdCacheEntry>();

/**
 * Extracts the 4-digit character model code from an NpcParam rowId.
 * Sekiro standard:
 *   50800000 -> c5080 (Gyoubu)
 *   10200000 -> c1020 (General)
 *   10700000 -> c1070 (Juzou)
 *   54000000 -> c5400 (Genichiro)
 */
export function extractChrId(rowId: number): string | null {
  if (typeof rowId !== 'number' || Number.isNaN(rowId)) return null;
  if (rowId >= 10000000) {
    const code = Math.floor(rowId / 10000);
    return `c${code}`;
  }
  if (rowId >= 1000 && rowId < 10000) {
    return `c${rowId}`;
  }
  return null;
}

export interface ResolveChrLinkageOptions {
  workspaceRoot: string;
  oodleRuntimeRoot?: string | undefined;
  bridgeExecutablePath?: string | undefined;
}

/**
 * Resolves all associated maps, EMEVD event files, boss UI events, and Lua scripts
 * for a given NpcParam rowId.
 */
export async function resolveChrLinkage(
  rowId: number,
  options: ResolveChrLinkageOptions
): Promise<ChrLinkageResult | null> {
  const chrId = extractChrId(rowId);
  if (!chrId) return null;

  const workspaceRoot = options.workspaceRoot;
  const oodleRuntimeRoot = options.oodleRuntimeRoot;
  const bridgeExecutablePath = options.bridgeExecutablePath;

  const result: ChrLinkageResult = {
    characterId: chrId,
    npcParamId: rowId,
    maps: [],
    associatedBossEvents: [],
    scripts: [],
    coverage: createCoverageState({
      scope: 'chr-linkage',
      domain: 'chr',
      status: 'not_indexed',
      predicateCompleteness: {
        kind: 'exact_handle',
        predicate: `NpcParam#${rowId}`,
        exhaustive: false,
        status: 'partial',
        reason: 'native linkage scan has not completed'
      }
    }),
    coverageByDomain: [],
    verifiedEdges: [],
    blockedReasons: [],
    nextReadPlan: []
  };

  let mapExpectedResources = 0;
  let mapCoveredResources = 0;
  let mapReadFailures = 0;
  let eventExpectedResources = 0;
  let eventCoveredResources = 0;
  let eventReadFailures = 0;
  let scriptSourceAvailable = false;
  let scriptReadFailures = 0;

  // 1. Scan MSB files for matching enemy parts
  const mapDir = join(workspaceRoot, 'map', 'mapstudio');
  if (existsSync(mapDir)) {
    let msbFiles: string[] = [];
    try {
      msbFiles = readdirSync(mapDir).filter((f) => f.endsWith('.msb.dcx'));
    } catch {
      mapReadFailures += 1;
    }
    mapExpectedResources = msbFiles.length;

    for (const f of msbFiles) {
      const fullPath = join(mapDir, f);
      let entry: MsbCacheEntry | undefined;
      try {
        const stats = statSync(fullPath);
        entry = msbCache.get(fullPath);
        if (!entry || entry.mtimeMs !== stats.mtimeMs) {
          const res = await runBridge<{ parts?: Array<{ name: string; entityId?: number }> }>({
            command: 'read-msb-document',
            filePath: fullPath,
            ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
            ...(bridgeExecutablePath ? { bridgeExecutablePath } : {})
          });
          const rawParts = res.data?.parts || [];
          const parts: Array<{ name: string; entityId?: number }> = [];
          for (const p of rawParts) {
            if (p.name) {
              parts.push(p.entityId !== undefined ? { name: p.name, entityId: p.entityId } : { name: p.name });
            }
          }
          entry = { mtimeMs: stats.mtimeMs, parts };
          msbCache.set(fullPath, entry);
        }
      } catch {
        mapReadFailures += 1;
        continue;
      }

      if (!entry) {
        mapReadFailures += 1;
        continue;
      }
      mapCoveredResources += 1;

      const matchedPart = entry.parts.find((p) => p.name.startsWith(chrId));
      if (matchedPart) {
        const mapId = f.replace('.msb.dcx', '');
        const eventFile = `event/${mapId}.emevd.dcx`;
        result.maps.push({
          mapFile: `map/mapstudio/${f}`,
          mapId,
          partName: matchedPart.name,
          eventFile
        });

        // 2. Scan associated EMEVD for Boss events
        const eventFullPath = join(workspaceRoot, eventFile);
        eventExpectedResources += 1;
        if (existsSync(eventFullPath)) {
          let evCache = emevdCache.get(eventFullPath);
          try {
            const evStats = statSync(eventFullPath);
            if (!evCache || evCache.mtimeMs !== evStats.mtimeMs) {
              const fullDoc = await readFullEmevdDocumentViaBridge({
                filePath: eventFullPath,
                allowedRoots: [workspaceRoot],
                resourceUri: `file://${eventFile}`,
                ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
                ...(bridgeExecutablePath ? { bridgeExecutablePath } : {})
              });

              const parsedEvents: EmevdParsedEvent[] = [];
              for (const ev of (fullDoc.document?.events || [])) {
                parsedEvents.push({
                  eventId: ev.eventId,
                  instructions: ev.instructions.map((i) => ({ bank: i.bank, id: i.id }))
                });
              }
              evCache = { mtimeMs: evStats.mtimeMs, events: parsedEvents };
              emevdCache.set(eventFullPath, evCache);
            }
          } catch {
            eventReadFailures += 1;
          }

          if (evCache) {
            eventCoveredResources += 1;
            const chrCode = rowId >= 10000000 ? Math.floor(rowId / 10000) : rowId;
            const m = mapId.match(/^m(\d+)_(\d+)/);
            const mapNum = m ? m[1] : '';
            const subNum = m && m[2] ? parseInt(m[2], 10) : 0;
            const mapPrefix = m ? `1${mapNum}${subNum}` : '';
            const thousands = Math.floor(chrCode / 1000);
            const tens = Math.floor((chrCode % 100) / 10);
            const encSuffix = `${thousands}${tens}`;
            const encPrefix = mapPrefix ? `${mapPrefix}${encSuffix}` : '';

            for (const ev of evCache.events) {
              const evStr = String(ev.eventId);
              const isMatch = encPrefix ? evStr.startsWith(encPrefix) : (evStr.includes(String(chrCode).slice(0, 3)) || evStr.includes(String(chrCode).slice(-3)));
              if (!isMatch) continue;

              let hasBossBar = false;
              let hasMinibossBar = false;
              let hasImmortality = false;
              let hasBossDefeat = false;
              let hasMinibossDefeat = false;

              for (const inst of ev.instructions) {
                if (inst.bank === 2003 && inst.id === 11) hasBossBar = true;
                else if (inst.bank === 2003 && inst.id === 87) hasMinibossBar = true;
                else if (inst.bank === 2004 && inst.id === 12) hasImmortality = true;
                else if (inst.bank === 2003 && inst.id === 12) hasBossDefeat = true;
                else if (inst.bank === 2003 && inst.id === 15) hasMinibossDefeat = true;
              }

              if (hasBossDefeat || hasMinibossDefeat || (hasBossBar && evStr.endsWith('00'))) {
                result.associatedBossEvents.push({
                  mapFile: `map/mapstudio/${f}`,
                  eventFile,
                  eventId: ev.eventId,
                  role: 'defeat_handling',
                  instructionName: hasMinibossDefeat ? 'HandleMinibossDefeat (2003[15])' : 'HandleBossDefeat (2003[12])',
                  keyInstructions: [
                    hasMinibossDefeat ? 'HandleMinibossDefeat (2003[15])' : 'HandleBossDefeat (2003[12])',
                    hasMinibossBar ? 'DisplayMinibossHealthBar (2003[87])' : 'DisplayBossHealthBar (2003[11])'
                  ],
                  description: '首领/精英怪击败与死亡结算：负责关闭血条与击败处理。'
                });
              } else if (hasBossBar || hasMinibossBar || evStr.endsWith('10')) {
                result.associatedBossEvents.push({
                  mapFile: `map/mapstudio/${f}`,
                  eventFile,
                  eventId: ev.eventId,
                  role: 'encounter_start',
                  instructionName: hasMinibossBar ? 'DisplayMinibossHealthBar (2003[87])' : 'DisplayBossHealthBar (2003[11])',
                  keyInstructions: [
                    hasMinibossBar ? 'DisplayMinibossHealthBar (2003[87])' : 'DisplayBossHealthBar (2003[11])',
                    ...(hasImmortality ? ['SetCharacterImmortality (2004[12])'] : [])
                  ],
                  description: '开战与血条初始化：负责全屏血条显示与开战状态设置。'
                });
              } else if (hasImmortality || evStr.endsWith('20')) {
                result.associatedBossEvents.push({
                  mapFile: `map/mapstudio/${f}`,
                  eventFile,
                  eventId: ev.eventId,
                  role: 'immortality_control',
                  instructionName: 'SetCharacterImmortality (2004[12])',
                  keyInstructions: ['SetCharacterImmortality (2004[12])'],
                  description: '不死锁状态维护：控制角色的不死身状态。'
                });
              }
            }
          }
        } else {
          eventReadFailures += 1;
        }
      }
    }
  }

  // 3. Scan scripts for AI behavior
  const scriptDir = join(workspaceRoot, 'script');
  if (existsSync(scriptDir)) {
    scriptSourceAvailable = true;
    try {
      const scriptFiles = readdirSync(scriptDir).filter((f) => f.endsWith('.luabnd.dcx'));
      const relevantMapIds = new Set(result.maps.map((m) => m.mapId));
      for (const bnd of scriptFiles) {
        const bndMap = bnd.replace('.luabnd.dcx', '');
        if (relevantMapIds.has(bndMap) || bnd === 'aicommon.luabnd.dcx') {
          result.scripts.push(`script/${bnd} (${chrId}_ai.lua)`);
        }
      }
    } catch {
      scriptReadFailures += 1;
    }
  }

  const mapCoverage = createCoverageState({
    scope: 'chr-linkage',
    domain: 'map',
    status: linkageCoverageStatus(mapExpectedResources, mapCoveredResources, mapReadFailures, existsSync(mapDir)),
    coveredResources: mapCoveredResources,
    expectedResources: mapExpectedResources,
    predicateCompleteness: {
      kind: 'exact_handle',
      predicate: `MSB part.name startsWith ${chrId}`,
      exhaustive: mapReadFailures === 0 && existsSync(mapDir),
      status: mapReadFailures === 0 && existsSync(mapDir) ? 'complete' : 'partial',
      reason: 'all discovered mapstudio MSB sources are checked before reporting a linkage miss'
    }
  });
  const eventCoverage = createCoverageState({
    scope: 'chr-linkage',
    domain: 'event',
    status: linkageCoverageStatus(eventExpectedResources, eventCoveredResources, eventReadFailures, eventExpectedResources > 0),
    coveredResources: eventCoveredResources,
    expectedResources: eventExpectedResources,
    predicateCompleteness: {
      kind: 'exact_handle',
      predicate: `event scope for ${chrId}`,
      exhaustive: eventReadFailures === 0 && eventExpectedResources > 0,
      status: eventReadFailures === 0 && eventExpectedResources > 0 ? 'complete' : 'partial',
      reason: 'only event files attached to confirmed map character parts are searched'
    }
  });
  const scriptFilesAvailable = scriptSourceAvailable && scriptReadFailures === 0;
  const scriptCoverage = createCoverageState({
    scope: 'chr-linkage',
    domain: 'script',
    status: scriptSourceAvailable
      ? scriptReadFailures > 0 ? 'parse_failed' : 'complete'
      : 'source_unavailable',
    coveredResources: result.scripts.length,
    expectedResources: scriptSourceAvailable ? result.scripts.length : null,
    predicateCompleteness: {
      kind: 'relationship',
      predicate: `${chrId} -> map-scoped AI script`,
      exhaustive: scriptFilesAvailable,
      status: scriptFilesAvailable ? 'complete' : 'partial',
      reason: scriptFilesAvailable ? 'script directory was enumerated' : 'script source is unavailable or failed to enumerate'
    }
  });

  const sourceSnapshot = { sourceUri: `param://NpcParam/${rowId}` };
  result.verifiedEdges.push({
    ruleId: 'npc-param.character-model',
    fromUri: `param://NpcParam/${rowId}`,
    toUri: `chr://${chrId}`,
    sourceProperty: 'rowId',
    targetNamespace: 'character-model',
    sourceSnapshot,
    targetConfirmed: true,
    confidence: 'high',
    evidence: 'declared NpcParam rowId -> cXXXX character model rule'
  });
  for (const map of result.maps) {
    const mapPath = join(workspaceRoot, map.mapFile);
    result.verifiedEdges.push({
      ruleId: 'character-model.map-part-name',
      fromUri: `chr://${chrId}`,
      toUri: `map://${map.mapId}/part/${map.partName}`,
      sourceProperty: 'part.name',
      targetNamespace: 'map-entity',
      sourceSnapshot: {
        sourceUri: mapPath,
        ...safeRevision(mapPath)
      },
      targetConfirmed: true,
      confidence: 'high',
      evidence: 'native MSB part name was read and matched the character model'
    });
  }
  for (const event of result.associatedBossEvents) {
    const eventPath = join(workspaceRoot, event.eventFile);
    result.verifiedEdges.push({
      ruleId: 'map-part.event-scope',
      fromUri: `chr://${chrId}`,
      toUri: `event://${event.eventFile}#${event.eventId}`,
      sourceProperty: 'eventId',
      targetNamespace: 'event',
      sourceSnapshot: {
        sourceUri: eventPath,
        ...safeRevision(eventPath)
      },
      targetConfirmed: true,
      confidence: 'medium',
      evidence: event.description
    });
  }
  for (const script of result.scripts) {
    result.verifiedEdges.push({
      ruleId: 'character-model.ai-script',
      fromUri: `chr://${chrId}`,
      toUri: `script://${script}`,
      sourceProperty: 'characterId',
      targetNamespace: 'ai-script',
      sourceSnapshot: sourceSnapshot,
      targetConfirmed: true,
      confidence: 'medium',
      evidence: 'script container was enumerated for the confirmed map scope'
    });
  }

  result.coverageByDomain = [mapCoverage, eventCoverage, scriptCoverage];
  result.coverage = createCoverageState({
    scope: 'chr-linkage',
    domain: 'chr',
    status: worstCoverageStatus([mapCoverage.status, eventCoverage.status, scriptCoverage.status]),
    coveredResources: mapCoveredResources + eventCoveredResources + result.scripts.length,
    expectedResources: mapExpectedResources + eventExpectedResources + (scriptSourceAvailable ? result.scripts.length : 0),
    predicateCompleteness: {
      kind: 'exact_handle',
      predicate: `NpcParam#${rowId} linkage closure`,
      exhaustive: result.coverageByDomain.every((coverage) => coverage.predicateCompleteness.exhaustive),
      status: result.coverageByDomain.every((coverage) => coverage.status === 'complete') ? 'complete' : 'partial',
      reason: 'linkage edges are emitted only after each source-domain scan reports its own coverage'
    }
  });
  if (mapReadFailures > 0) result.blockedReasons.push('MAP_NATIVE_READ_FAILED');
  if (eventReadFailures > 0) result.blockedReasons.push('EVENT_NATIVE_READ_FAILED');
  if (!scriptSourceAvailable) result.blockedReasons.push('SCRIPT_SOURCE_UNAVAILABLE');
  if (scriptReadFailures > 0) result.blockedReasons.push('SCRIPT_SOURCE_ENUMERATION_FAILED');
  if (result.coverage.status !== 'complete') {
    result.nextReadPlan.push({
      stepId: 'refresh-stale-linkage-sources',
      target: 'chr-linkage',
      reason: 'refresh or reread the incomplete source domains before using the closure for mutation',
      requiredForMutation: true
    });
  }

  return result;
}

function linkageCoverageStatus(
  expected: number,
  covered: number,
  failures: number,
  sourceAvailable: boolean
): CoverageState['status'] {
  if (!sourceAvailable) return 'source_unavailable';
  if (failures > 0) return 'parse_failed';
  if (covered < expected) return 'partial';
  return 'complete';
}

function worstCoverageStatus(statuses: readonly CoverageState['status'][]): CoverageState['status'] {
  const order: Record<CoverageState['status'], number> = {
    complete: 0,
    partial: 1,
    not_indexed: 2,
    stale: 3,
    parse_failed: 4,
    source_unavailable: 5
  };
  return statuses.reduce((worst, status) => order[status] > order[worst] ? status : worst, 'complete');
}

function safeRevision(path: string): { sourceRevision?: number } {
  try {
    return { sourceRevision: statSync(path).mtimeMs };
  } catch {
    return {};
  }
}
