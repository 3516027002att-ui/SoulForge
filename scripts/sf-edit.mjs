#!/usr/bin/env node
/**
 * Thin CLI for Agent native edits. Logic lives in @soulforge/core.
 *
 *   node scripts/sf-edit.mjs param read|set ...
 *   node scripts/sf-edit.mjs fmg   read|set ...
 *   node scripts/sf-edit.mjs emevd read|apply-dsl ...
 *   node scripts/sf-edit.mjs tae   read|set --file chr/c1050.anibnd.dcx --set c1050#A0200.e0.startFrame=438
 *   node scripts/sf-edit.mjs msb   read|set --file map/m11_01_00_00/m11_01_00_00.msb.dcx --set m11_01_00_00#c1050_0000.posX=12.5
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { disposeBridgeDaemonPool } from '../packages/core/dist/bridge/runBridge.js';
import { applyEmevdDsl, readEmevdOutline } from '../packages/core/dist/editing/emevdEdit.js';
import { openNativeEditSession } from '../packages/core/dist/editing/nativeEditSession.js';
import { readFmgEntries, setFmgEntries } from '../packages/core/dist/editing/fmgEdit.js';
import { readParamFields, setParamFields } from '../packages/core/dist/param/containerParamEdit.js';
import { readTaeEvents, setTaeEventTimes } from '../packages/core/dist/editing/taeEdit.js';
import { readMsbParts, setMsbPartTransform } from '../packages/core/dist/editing/msbEdit.js';

const PARAM_SET_RE = /^([^#]+)#(\d+)\.([A-Za-z0-9_]+)=(.*)$/u;
const FMG_SET_RE = /^([^#]+)#(\d+)=(.*)$/u;
const TAE_SET_RE = /^(c\d{4}#A\d+\.e\d+)\.([A-Za-z0-9_]+)=(.*)$/u;
const MSB_SET_RE = /^(m\d{2}_\d{2}_\d{2}_\d{2}#[^.\s]+)\.([A-Za-z0-9_]+)=(.*)$/u;
const TAE_SETTABLE_FIELDS = ['startFrame', 'endFrame'];
const MSB_TRANSFORM_FIELDS = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'scaleX', 'scaleY', 'scaleZ'];

function fail(code, message, extra) {
  console.log(JSON.stringify({ ok: false, error: { code, message }, ...extra }, null, 2));
  process.exitCode = 1;
}

function argMap(argv) {
  const flags = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, true);
      } else {
        const existing = flags.get(key);
        flags.set(key, existing === undefined ? next : [].concat(existing, next));
        i += 1;
      }
      continue;
    }
    rest.push(token);
  }
  return { flags, rest };
}

function asList(value) {
  if (value === undefined || value === true) return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

function flagStrings(flags, key) {
  const raw = flags.get(key);
  if (raw === undefined || raw === true) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function parseParamSets(flags) {
  const edits = [];
  for (const raw of flagStrings(flags, 'set')) {
    const match = PARAM_SET_RE.exec(raw);
    if (!match) {
      fail('PARAM_SET_SYNTAX', `无法解析 --set ${raw}，格式为 Table#rowId.field=value`);
      return null;
    }
    edits.push({
      table: match[1],
      rowId: Number(match[2]),
      fieldId: match[3],
      value: parseValue(match[4])
    });
  }
  return edits;
}

function parseFmgSets(flags) {
  const edits = [];
  for (const raw of flagStrings(flags, 'set')) {
    const match = FMG_SET_RE.exec(raw);
    if (!match) {
      fail('FMG_SET_SYNTAX', `无法解析 --set ${raw}，格式为 Table#id=文本`);
      return null;
    }
    edits.push({ table: match[1], id: Number(match[2]), text: match[3] });
  }
  return edits;
}

function parseTaeSets(flags) {
  const edits = [];
  for (const raw of flagStrings(flags, 'set')) {
    const match = TAE_SET_RE.exec(raw);
    if (!match) {
      fail('TAE_SET_SYNTAX', `无法解析 --set ${raw}，格式为 cXXXX#AXXXX.eN.startFrame=帧`);
      return null;
    }
    const field = match[2];
    if (!TAE_SETTABLE_FIELDS.includes(field)) {
      fail('TAE_SET_FIELD_READONLY', `TAE 门面只开放 ${TAE_SETTABLE_FIELDS.join(' / ')}（未解码参数不开放 set）：${field}`);
      return null;
    }
    edits.push({ address: match[1], [field]: Number(match[3]) });
  }
  return edits;
}

function parseMsbSets(flags) {
  const edits = [];
  for (const raw of flagStrings(flags, 'set')) {
    const match = MSB_SET_RE.exec(raw);
    if (!match) {
      fail('MSB_SET_SYNTAX', `无法解析 --set ${raw}，格式为 mAA_BB_CC_DD#part.posX=值`);
      return null;
    }
    const field = match[2];
    if (!MSB_TRANSFORM_FIELDS.includes(field)) {
      fail('MSB_SET_FIELD_UNKNOWN', `MSB 门面只接受变换字段 ${MSB_TRANSFORM_FIELDS.join(' / ')}：${field}`);
      return null;
    }
    edits.push({ address: match[1], [field]: Number(match[3]) });
  }
  return edits;
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const kind = argv[0];
  const action = argv[1];
  const { flags } = argMap(argv.slice(2));
  const usage = '用法: node scripts/sf-edit.mjs param|fmg|emevd|tae|msb <read|set|apply-dsl> --workspace <mods> ...';
  const kindOk = ['param', 'fmg', 'emevd', 'tae', 'msb'].includes(kind);
  const actionOk = kind === 'emevd'
    ? (action === 'read' || action === 'apply-dsl')
    : (action === 'read' || action === 'set');
  if (!kindOk || !actionOk) {
    fail('SF_EDIT_USAGE', usage);
    return;
  }
  const workspace = flags.get('workspace');
  if (typeof workspace !== 'string' || workspace.length === 0) {
    fail('SF_EDIT_WORKSPACE_REQUIRED', '必须提供 --workspace。');
    return;
  }
  const edit = await openNativeEditSession({
    overlayRoot: resolve(workspace),
    ...(typeof flags.get('game') === 'string' ? { baseRoot: resolve(String(flags.get('game'))) } : {}),
    game: 'sekiro'
  });
  const containerPath = typeof flags.get('container') === 'string' ? resolve(String(flags.get('container'))) : undefined;
  const lang = typeof flags.get('lang') === 'string' ? String(flags.get('lang')) : undefined;

  if (kind === 'param' && action === 'read') {
    const table = flags.get('table');
    const rows = asList(flags.get('rows')).map(Number).filter((id) => Number.isInteger(id));
    const fields = asList(flags.get('fields'));
    if (typeof table !== 'string' || rows.length === 0 || fields.length === 0) {
      fail('SF_EDIT_READ_ARGS', 'param read 需要 --table --rows --fields。');
      return;
    }
    printResult(await readParamFields({
      edit,
      queries: [{ table, rowIds: rows, fieldIds: fields }],
      ...(containerPath ? { containerPath } : {})
    }));
    return;
  }
  if (kind === 'param' && action === 'set') {
    const edits = parseParamSets(flags);
    if (!edits) return;
    if (edits.length === 0) {
      fail('PARAM_EDIT_EMPTY', 'param set 需要 --set Table#row.field=value');
      return;
    }
    printResult(await setParamFields({ edit, edits, ...(containerPath ? { containerPath } : {}) }));
    return;
  }
  if (kind === 'fmg' && action === 'read') {
    const table = flags.get('table');
    const ids = asList(flags.get('ids')).map(Number).filter((id) => Number.isInteger(id));
    if (typeof table !== 'string' || ids.length === 0) {
      fail('SF_EDIT_READ_ARGS', 'fmg read 需要 --table --ids。');
      return;
    }
    printResult(await readFmgEntries({
      edit,
      table,
      ids,
      ...(containerPath ? { containerPath } : {}),
      ...(lang ? { lang } : {})
    }));
    return;
  }
  if (kind === 'fmg' && action === 'set') {
    const edits = parseFmgSets(flags);
    if (!edits) return;
    if (edits.length === 0) {
      fail('FMG_EDIT_EMPTY', 'fmg set 需要 --set Table#id=文本');
      return;
    }
    printResult(await setFmgEntries({
      edit,
      edits,
      ...(containerPath ? { containerPath } : {}),
      ...(lang ? { lang } : {})
    }));
    return;
  }
  if (kind === 'tae') {
    const file = flags.get('file');
    if (typeof file !== 'string' || file.length === 0) {
      fail('SF_EDIT_FILE_REQUIRED', 'tae 需要 --file（anibnd，如 chr/c1050.anibnd.dcx）。');
      return;
    }
    if (action === 'read') {
      const addresses = asList(flags.get('addr'));
      printResult(await readTaeEvents({ edit, file, ...(addresses.length > 0 ? { addresses } : {}) }));
      return;
    }
    const edits = parseTaeSets(flags);
    if (!edits) return;
    if (edits.length === 0) {
      fail('TAE_EDIT_EMPTY', 'tae set 需要 --set cXXXX#AXXXX.eN.startFrame=帧');
      return;
    }
    printResult(await setTaeEventTimes({ edit, file, edits }));
    return;
  }
  if (kind === 'msb') {
    const file = flags.get('file');
    if (typeof file !== 'string' || file.length === 0) {
      fail('SF_EDIT_FILE_REQUIRED', 'msb 需要 --file（msb，如 map/m11_01_00_00/m11_01_00_00.msb.dcx）。');
      return;
    }
    if (action === 'read') {
      const addresses = asList(flags.get('addr'));
      printResult(await readMsbParts({ edit, file, ...(addresses.length > 0 ? { addresses } : {}) }));
      return;
    }
    const edits = parseMsbSets(flags);
    if (!edits) return;
    if (edits.length === 0) {
      fail('MSB_EDIT_EMPTY', 'msb set 需要 --set mAA_BB_CC_DD#part.posX=值');
      return;
    }
    printResult(await setMsbPartTransform({ edit, file, edits }));
    return;
  }
  const file = flags.get('file');
  if (typeof file !== 'string' || file.length === 0) {
    fail('SF_EDIT_FILE_REQUIRED', 'emevd 需要 --file。');
    return;
  }
  if (action === 'read') {
    printResult(await readEmevdOutline({ edit, file }));
    return;
  }
  let dsl = typeof flags.get('dsl') === 'string' ? String(flags.get('dsl')) : '';
  if (!dsl && typeof flags.get('dsl-file') === 'string') {
    dsl = await readFile(resolve(String(flags.get('dsl-file'))), 'utf8');
  }
  printResult(await applyEmevdDsl({
    edit,
    file,
    dsl,
    mode: flags.get('mode') === 'dark-script' ? 'dark-script' : 'patch',
    ...(typeof flags.get('emedf') === 'string' ? { emedfPath: resolve(String(flags.get('emedf'))) } : {})
  }));
}

main()
  .catch((error) => {
    fail('SF_EDIT_CRASH', error instanceof Error ? error.stack ?? error.message : String(error));
  })
  .finally(() => disposeBridgeDaemonPool());
