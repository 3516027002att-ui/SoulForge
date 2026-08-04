/**
 * Native collision/navigation inventory smoke (read-only): enumerate BND4
 * container children in the Sekiro corpus and search for collision / navigation /
 * MTD assets. Produces honest negative evidence when the corpus contains none.
 *
 * Findings (verified 2026-08-04 against the local corpus):
 *   - m10 mapbnd contains only 2 FLVER children (main mesh + shadow); no hkx/hkt/nav/nvmtx/col.
 *   - chrbnd containers carry skeleton/ragdoll HKX + CLM2 (action rigging), NOT map collision.
 *   - Recursive corpus search for *.hkx/*.hkt/*.nav/*.nvmtx/*.col/*.mtd returns 0 hits.
 *
 * Implication: Sekiro's gameplay collision/navmesh lives in the game's own
 * archives (Data/... ) outside this mods corpus. The `_c.hkx` / navmesh reader
 * integration point is reserved; no format authority is claimed here.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { readdirSync, existsSync, accessSync, statSync, constants } from 'node:fs';
import { join, dirname, relative } from 'node:path';

function fixtureRoot(): string {
  return process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '';
}

const CORPUS_EXT_PATTERNS = /\.(hkx|hkt|nav|nvmtx|col|mtd|phkx|pht)$/i;

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 6 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1, out);
    else if (CORPUS_EXT_PATTERNS.test(name)) out.push(p);
  }
}

interface InventoryEntry {
  name: string;
  id: number;
}

async function inventory(root: string, relPath: string): Promise<{ kind: string; entries: InventoryEntry[]; diagnostics: string[] }> {
  const filePath = join(root, relPath);
  const r = await runBridge<{ containerType: string; entryCount: number; sampleEntries: InventoryEntry[] }>({
    command: 'inventory-asset-resources',
    filePath,
    allowedRoots: [dirname(filePath)],
    oodleRuntimeRoot: root,
    timeoutMs: 180_000
  });
  if (r.parseStatus === 'failed') {
    return { kind: 'failed', entries: [], diagnostics: r.diagnostics?.map((d) => `${d.code}: ${d.message}`) ?? [] };
  }
  return {
    kind: r.data?.containerType ?? 'none',
    entries: r.data?.sampleEntries ?? [],
    diagnostics: r.diagnostics?.map((d) => d.code) ?? []
  };
}

async function main(): Promise<void> {
  const root = fixtureRoot();
  if (!root || !existsSync(join(root, 'mods'))) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      message: '未配置本机 Sekiro 根（SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT）。'
    }));
    return;
  }
  accessSync(root, constants.R_OK);

  // 1) m10 mapbnd children enumeration
  const mapbndRel = 'mods/map/m10_00_00_00/m10_00_00_00_600050.mapbnd.dcx';
  const mapbnd = await inventory(root, mapbndRel);

  // 2) chrbnd children enumeration (skeleton/ragdoll HKX present, not map collision)
  const chrbndRel = 'mods/chr/c1020.chrbnd.dcx';
  const chrbnd = await inventory(root, chrbndRel);

  // 3) recursive corpus search for collision/nav/MTD assets
  const hits: string[] = [];
  walk(join(root, 'mods'), 0, hits);

  const report = {
    ok: mapbnd.kind !== 'failed',
    message: 'collision/navigation/MTD corpus 侦察（只读）',
    mapbnd: {
      container: mapbndRel,
      kind: mapbnd.kind,
      diagnostics: mapbnd.diagnostics,
      children: mapbnd.entries
    },
    chrbnd: {
      container: chrbndRel,
      kind: chrbnd.kind,
      children: chrbnd.entries.filter((e) => /\.(hkx|clm2|flver|tpf)$/i.test(e.name))
    },
    corpusSearch: {
      patterns: ['*.hkx', '*.hkt', '*.nav', '*.nvmtx', '*.col', '*.mtd'],
      hits: hits.map((p) => relative(root, p)),
      hitCount: hits.length
    },
    conclusion: hits.length === 0
      ? 'corpus 内不存在碰撞/导航/MTD 源文件；Sekiro 碰撞与导航位于游戏本体 archive，不在 mods corpus。' +
        'hkt/hkx/nav 只读 header 解析器未实现，属真实缺口（无样本可验），预留 _c.hkx/navmesh 接入点。'
      : 'corpus 内发现上述碰撞/导航候选文件，需按扩展名逐个实现只读 header 解析。'
  };
  console.log(JSON.stringify(report, null, 2));

  await disposeBridgeDaemonPool();
  if (mapbnd.kind === 'failed') process.exitCode = 1;
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
