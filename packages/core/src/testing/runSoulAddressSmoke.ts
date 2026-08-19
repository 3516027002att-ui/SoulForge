/**
 * 动作 / 地图参数同构编址的纯函数 smoke（问题 6-A）。
 *
 * 全仓唯一解析 / 格式化入口是 packages/shared/src/soulAddress.ts。这里钉住
 * 地址语法与 queryParse 的原子地址行为：m11_01_00_00 不得被拆成四截、
 * a000_020000 不得被拆成 a000 与 020000、带 # 的完整地址整体保留。
 *
 * 纯逻辑，无 native 语料依赖，归 unit。
 */
import {
  extractAtomicAddressTokens,
  formatActionAddress,
  formatAnimCode,
  formatChrId,
  formatMapAddress,
  formatMapArea,
  formatMapBlock,
  parseActionAddress,
  parseAnimCode,
  parseMapAddress
} from '@soulforge/shared';
import { parseRagQuery } from '../rag/queryParse.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`soulAddress smoke failed: ${message}`);
}

function main(): void {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

function run(): void {
  // ── formatAnimCode / parseAnimCode ──
  assert(formatAnimCode(200) === 'A0200', `formatAnimCode(200) === 'A0200', got ${formatAnimCode(200)}`);
  assert(formatAnimCode(7) === 'A0007', `formatAnimCode(7) === 'A0007', got ${formatAnimCode(7)}`);
  assert(parseAnimCode('A200') === 200, `parseAnimCode('A200') === 200, got ${String(parseAnimCode('A200'))}`);
  assert(parseAnimCode('A0200') === 200, `parseAnimCode('A0200') === 200`);
  assert(parseAnimCode('not-an-anim') === null, 'parseAnimCode must fail closed on garbage');

  // ── formatChrId ──
  assert(formatChrId('chr/c1050.anibnd.dcx') === 'c1050', 'formatChrId from anibnd path');
  assert(formatChrId('c1050.chrbnd.dcx') === 'c1050', 'formatChrId from chrbnd path');
  assert(formatChrId('c1050') === 'c1050', 'formatChrId from bare stem');
  assert(formatChrId('map/m11_01_00_00/a000.hkx') === null, 'formatChrId must reject non chr');

  // ── formatMapBlock / formatMapArea / formatMapAddress ──
  assert(
    formatMapBlock('map/m11_01_00_00/m11_01_00_00.msb.dcx') === 'm11_01_00_00',
    'formatMapBlock must extract four-segment block'
  );
  assert(formatMapArea('m11_01_00_00') === 'M11', `formatMapArea('m11_01_00_00') === 'M11', got ${formatMapArea('m11_01_00_00')}`);
  assert(
    formatMapAddress({ block: 'm11_01_00_00', name: 'c1050_0000', field: 'posX' }) === 'm11_01_00_00#c1050_0000.posX',
    'formatMapAddress full form'
  );

  // ── parseActionAddress ──
  const parsedAction = parseActionAddress('c1050#A0200.e0.startFrame');
  assert(
    parsedAction !== null
      && parsedAction.chr === 'c1050'
      && parsedAction.animId === 200
      && parsedAction.eventIndex === 0
      && parsedAction.field === 'startFrame',
    `parseActionAddress('c1050#A0200.e0.startFrame') fields, got ${JSON.stringify(parsedAction)}`
  );
  const parsedActionChrOnly = parseActionAddress('c1050');
  assert(
    parsedActionChrOnly !== null && parsedActionChrOnly.chr === 'c1050' && parsedActionChrOnly.animId === undefined,
    'parseActionAddress chr-only'
  );
  assert(parseActionAddress('c1050#a000_020000') === null, 'parseActionAddress must fail closed on hkx alias');
  assert(parseActionAddress('m11_01_00_00#c1050_0000') === null, 'parseActionAddress must reject map address');

  // ── parseMapAddress ──
  const parsedMap = parseMapAddress('m11_01_00_00#c1050_0000.posX');
  assert(
    parsedMap !== null
      && parsedMap.block === 'm11_01_00_00'
      && parsedMap.name === 'c1050_0000'
      && parsedMap.field === 'posX',
    `parseMapAddress('m11_01_00_00#c1050_0000.posX') fields, got ${JSON.stringify(parsedMap)}`
  );
  assert(parseMapAddress('c1050#A0200') === null, 'parseMapAddress must reject action address');

  // ── format / parse round trips ──
  assert(
    parseMapAddress(formatMapAddress({ block: 'm11_01_00_00', name: 'boss_phase_2' }))?.name === 'boss_phase_2',
    'formatMapAddress → parseMapAddress round trip'
  );
  assert(
    parseActionAddress(formatActionAddress({ chr: 'c1050', animId: 200, eventIndex: 3 }))?.eventIndex === 3,
    'formatActionAddress → parseActionAddress round trip'
  );

  // ── extractAtomicAddressTokens ──
  const tokens = extractAtomicAddressTokens('查 m11_01_00_00 的 c1050_0000');
  assert(
    tokens.includes('m11_01_00_00'),
    `extractAtomicAddressTokens must keep four-segment block atomic, got ${JSON.stringify(tokens)}`
  );
  const stemTokens = extractAtomicAddressTokens('anim A0200 animId 200 hkx a000_020000');
  assert(
    stemTokens.includes('a000_020000') && stemTokens.includes('a0200'),
    `extractAtomicAddressTokens must keep hkx stem & anim code atomic, got ${JSON.stringify(stemTokens)}`
  );
  const addressTokens = extractAtomicAddressTokens('改 c1050#A0200.e0.startFrame 到 438');
  assert(
    addressTokens.includes('c1050#a0200.e0.startframe') && addressTokens.includes('c1050') && addressTokens.includes('a0200'),
    `extractAtomicAddressTokens must keep full action address, got ${JSON.stringify(addressTokens)}`
  );

  // ── parseRagQuery 原子地址（问题 6-A：queryParse 不再拆地址）──
  const mapQuery = parseRagQuery('m11_01_00_00');
  assert(
    mapQuery.terms.includes('m11_01_00_00') || mapQuery.phrases.includes('m11_01_00_00'),
    `parseRagQuery('m11_01_00_00') must keep atomic block, terms=${JSON.stringify(mapQuery.terms)} phrases=${JSON.stringify(mapQuery.phrases)}`
  );
  const actionQuery = parseRagQuery('c1050#A0200');
  assert(
    actionQuery.terms.includes('c1050') && actionQuery.terms.includes('a0200'),
    `parseRagQuery('c1050#A0200') must yield c1050 and a0200, terms=${JSON.stringify(actionQuery.terms)}`
  );

  console.log(JSON.stringify({
    ok: true,
    message: 'soulAddress smoke: ok',
    nonClaims: ['纯函数地址语法，不证明原生 TAE/MSB 解析']
  }, null, 2));
}

main();
