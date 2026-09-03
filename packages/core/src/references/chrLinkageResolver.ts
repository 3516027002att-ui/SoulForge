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

export interface ChrLinkageResult {
  characterId: string;
  npcParamId: number;
  maps: ChrMapLink[];
  associatedBossEvents: ChrBossEventLink[];
  scripts: string[];
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
    scripts: []
  };

  // 1. Scan MSB files for matching enemy parts
  const mapDir = join(workspaceRoot, 'map', 'mapstudio');
  if (existsSync(mapDir)) {
    let msbFiles: string[] = [];
    try {
      msbFiles = readdirSync(mapDir).filter((f) => f.endsWith('.msb.dcx'));
    } catch {
      // Ignored if directory cannot be read
    }

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
        continue;
      }

      if (!entry) continue;

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
            // Emevd reading failure handled gracefully
          }

          if (evCache) {
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
                  description: '首领/精英怪击败与死亡结算：负责关闭血条与击败处理。大首领在此等待SpEffect 201000特殊忍杀；改为精英怪时需换用 HandleMinibossDefeat 并直接监听实体死亡。'
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
                  description: '开战与血条初始化：负责全屏血条显示。大首领在此开启 SetCharacterImmortality(1) 导致特殊忍杀；改为精英怪需换用 DisplayMinibossHealthBar 并移除不死锁。'
                });
              } else if (hasImmortality || evStr.endsWith('20')) {
                result.associatedBossEvents.push({
                  mapFile: `map/mapstudio/${f}`,
                  eventFile,
                  eventId: ev.eventId,
                  role: 'immortality_control',
                  instructionName: 'SetCharacterImmortality (2004[12])',
                  keyInstructions: ['SetCharacterImmortality (2004[12])'],
                  description: '不死锁状态维护：控制角色不死。改为精英怪时需确保不赋予不死(0)，使清空红点后可直接致命忍杀死亡。'
                });
              }
            }
          }
        }
      }
    }
  }

  // 3. Scan scripts for AI behavior
  const scriptDir = join(workspaceRoot, 'script');
  if (existsSync(scriptDir)) {
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
      // Ignored
    }
  }

  return result;
}
