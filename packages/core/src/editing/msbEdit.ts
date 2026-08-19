/**
 * Agent / CLI MSB facade（问题 6-F）。
 *
 * 读：read-msb-document。写：只接已有 Bridge mutation —— msb_set_part_position /
 * msb_set_part_transform（write-msb），经 applyNativeMutation → Patch Engine 提交。
 *
 * 入参是地址字符串（m11_01_00_00#c1050_0000），内部 parseMapAddress。未解码的
 * 其他 MSB 字段不开放 set。
 */
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Diagnostic } from '@soulforge/shared';
import { formatMapAddress, parseMapAddress } from '@soulforge/shared';
import { applyNativeMutation } from './editorMutationService.js';
import { commitMsbMutationViaBridge, type MsbBridgeMutation } from './msbBridgeCommit.js';
import { readMsbDocumentViaBridge } from './msbBridgeRead.js';
import type { NativeEditSession } from './nativeEditSession.js';

export interface MsbPartSnapshot {
  address: string;
  name: string;
  typeId: number;
  mapId: string;
  posX: number;
  posY: number;
  posZ: number;
  rotX?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export interface MsbPartTransformEdit {
  /** `m11_01_00_00#c1050_0000`。 */
  address: string;
  posX?: number;
  posY?: number;
  posZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export interface MsbEditFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type MsbReadResult =
  | { ok: true; filePath: string; mapId: string; parts: MsbPartSnapshot[]; diagnostics: Diagnostic[] }
  | { ok: false; error: MsbEditFailure; diagnostics: Diagnostic[] };

export type MsbSetResult =
  | { ok: true; filePath: string; before: MsbPartSnapshot[]; after: MsbPartSnapshot[]; mutations: number; diagnostics: Diagnostic[] }
  | { ok: false; error: MsbEditFailure; diagnostics: Diagnostic[]; before?: MsbPartSnapshot[] };

/** 只写变换变体（set_part_position / set_part_transform），不含 delete。 */
interface MsbTransformMutation {
  kind: 'set_part_position' | 'set_part_transform';
  partName: string;
  posX?: number;
  posY?: number;
  posZ?: number;
  rotX?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export async function readMsbParts(input: {
  edit: NativeEditSession;
  file: string;
  addresses?: string[];
}): Promise<MsbReadResult> {
  const resolved = await resolveMsbFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const mapId = resolved.mapId;
  const doc = await readMsbDocumentViaBridge({
    sourcePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (!doc.ok || !doc.data) {
    return { ok: false, error: { code: 'MSB_READ_FAILED', message: `无法读取 MSB：${resolved.path}` }, diagnostics: asDiagnostics(doc.diagnostics) };
  }
  const parts = doc.data.parts.map((part) => ({
    address: formatMapAddress({ block: mapId, name: part.name }),
    name: part.name,
    typeId: part.typeId,
    mapId,
    posX: part.posX,
    posY: part.posY,
    posZ: part.posZ,
    ...(part.rotX !== undefined ? { rotX: part.rotX } : {}),
    ...(part.scaleX !== undefined ? { scaleX: part.scaleX } : {}),
    ...(part.scaleY !== undefined ? { scaleY: part.scaleY } : {}),
    ...(part.scaleZ !== undefined ? { scaleZ: part.scaleZ } : {})
  }));
  const wanted = (input.addresses ?? []).map((address) => parseMapAddress(address));
  if (wanted.some((item) => item === null)) {
    return {
      ok: false,
      error: {
        code: 'MSB_ADDRESS_INVALID',
        message: `地址无法解析：${(input.addresses ?? []).filter((_, i) => wanted[i] === null).join(', ')}`
      },
      diagnostics: []
    };
  }
  let selected = parts;
  if (wanted.length > 0) {
    const wantedNames = wanted.filter((item) => item !== null).map((item) => item!.name).filter((name) => name !== undefined);
    if (wantedNames.length > 0) {
      selected = parts.filter((part) => wantedNames.includes(part.name));
      const missing = wantedNames.filter((name) => !selected.some((part) => part.name === name));
      if (missing.length > 0) {
        return {
          ok: false,
          error: { code: 'MSB_PART_NOT_FOUND', message: `请求的 part 不存在：${missing.join(', ')}（文件 ${resolved.path}）` },
          diagnostics: []
        };
      }
    }
  }
  return { ok: true, filePath: resolved.path, mapId, parts: selected, diagnostics: asDiagnostics(doc.diagnostics) };
}

export async function setMsbPartTransform(input: {
  edit: NativeEditSession;
  file: string;
  edits: MsbPartTransformEdit[];
}): Promise<MsbSetResult> {
  if (input.edits.length === 0) {
    return { ok: false, error: { code: 'MSB_EDIT_EMPTY', message: '没有要写入的变换。' }, diagnostics: [] };
  }
  const resolved = await resolveMsbFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const doc = await readMsbDocumentViaBridge({
    sourcePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (!doc.ok || !doc.data) {
    return { ok: false, error: { code: 'MSB_READ_FAILED', message: `无法读取 MSB：${resolved.path}` }, diagnostics: asDiagnostics(doc?.diagnostics ?? []) };
  }

  const before: MsbPartSnapshot[] = [];
  const mutations: MsbTransformMutation[] = [];
  for (const edit of input.edits) {
    const parsed = parseMapAddress(edit.address);
    if (!parsed || !parsed.name) {
      return { ok: false, error: { code: 'MSB_ADDRESS_INVALID', message: `地址需含 part 名：${edit.address}` }, diagnostics: [] };
    }
    const part = doc.data.parts.find((item) => item.name === parsed.name);
    if (!part) {
      return { ok: false, error: { code: 'MSB_PART_NOT_FOUND', message: `part 不存在：${parsed.name}（文件 ${resolved.path}）` }, diagnostics: [] };
    }
    if (!hasAnyTransform(edit)) {
      return { ok: false, error: { code: 'MSB_EDIT_EMPTY', message: `${edit.address} 没有任何要写入的变换字段。` }, diagnostics: [] };
    }
    before.push({
      address: formatMapAddress({ block: resolved.mapId, name: part.name }),
      name: part.name,
      typeId: part.typeId,
      mapId: resolved.mapId,
      posX: part.posX,
      posY: part.posY,
      posZ: part.posZ,
      ...(part.rotX !== undefined ? { rotX: part.rotX } : {}),
      ...(part.scaleX !== undefined ? { scaleX: part.scaleX } : {}),
      ...(part.scaleY !== undefined ? { scaleY: part.scaleY } : {}),
      ...(part.scaleZ !== undefined ? { scaleZ: part.scaleZ } : {})
    });
    const mutation: MsbTransformMutation = {
      kind: hasRotScale(edit) ? 'set_part_transform' : 'set_part_position',
      partName: parsed.name,
      ...(edit.posX !== undefined ? { posX: edit.posX } : {}),
      ...(edit.posY !== undefined ? { posY: edit.posY } : {}),
      ...(edit.posZ !== undefined ? { posZ: edit.posZ } : {}),
      ...(edit.rotX !== undefined ? { rotX: edit.rotX } : {}),
      ...(edit.scaleX !== undefined ? { scaleX: edit.scaleX } : {}),
      ...(edit.scaleY !== undefined ? { scaleY: edit.scaleY } : {}),
      ...(edit.scaleZ !== undefined ? { scaleZ: edit.scaleZ } : {})
    };
    mutations.push(mutation);
  }

  const file = await input.edit.indexFile(resolved.path, 'map');
  const expectedHash = file.sha256 || await sha256Of(resolved.path);
  // 本图块一次调用只写一个 part（避跨容器哈希串扰），多 part 逐条提交。
  const after: MsbPartSnapshot[] = [];
  for (const mutation of mutations) {
    const outcome = await applyNativeMutation({
      file: { ...file, sha256: expectedHash },
      sourceUri: file.sourceUri,
      expectedHash,
      stagingRoot: input.edit.stagingRoot,
      allowedRoots: () => [...input.edit.allowedRoots()],
      stagingPrefix: 'msb',
      stagingFileName: `${basename(resolved.path)}.mut.msb`,
      stageWrite: (context) => commitMsbMutationViaBridge({
        sourcePath: resolved.path,
        outputPath: context.outputPath,
        expectedDocumentHash: expectedHash,
        allowedRoots: context.allowedRoots,
        writableRoots: context.writableRoots,
        mutation,
        timeoutMs: 120_000
      }),
      title: `MSB transform ${mutation.partName} in ${basename(resolved.path)}`,
      confirmActionLabel: '提交 MSB part 变换'
    }, { commit: input.edit.commitPort });
    if (outcome.status !== 'committed' || !outcome.result.ok) {
      const diagnostics = outcome.status === 'failed'
        ? outcome.diagnostics
        : outcome.status === 'committed'
          ? outcome.result.diagnostics
          : [{ severity: 'error' as const, code: 'MSB_WRITE_CANCELLED', message: '写入被取消。', sourceUri: file.sourceUri }];
      return {
        ok: false,
        error: { code: diagnostics[0]?.code ?? 'MSB_WRITE_FAILED', message: diagnostics[0]?.message ?? 'MSB 写入失败。' },
        diagnostics,
        before
      };
    }
  }
  const reread = await readMsbDocumentViaBridge({
    sourcePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (reread.ok && reread.data) {
    for (const name of mutations.map((m) => m.partName)) {
      const part = reread.data.parts.find((item) => item.name === name);
      if (part) {
        after.push({
          address: formatMapAddress({ block: resolved.mapId, name: part.name }),
          name: part.name,
          typeId: part.typeId,
          mapId: resolved.mapId,
          posX: part.posX,
          posY: part.posY,
          posZ: part.posZ,
          ...(part.rotX !== undefined ? { rotX: part.rotX } : {}),
          ...(part.scaleX !== undefined ? { scaleX: part.scaleX } : {}),
          ...(part.scaleY !== undefined ? { scaleY: part.scaleY } : {}),
          ...(part.scaleZ !== undefined ? { scaleZ: part.scaleZ } : {})
        });
      }
    }
  } else {
    // 读回失败：以「要写的值 + 未变的旧值」合成 after，不吞异常、如实标注。
    for (const mutation of mutations) {
      const old = before.find((item) => item.name === mutation.partName);
      after.push({
        address: formatMapAddress({ block: resolved.mapId, name: mutation.partName }),
        name: mutation.partName,
        typeId: old?.typeId ?? 0,
        mapId: resolved.mapId,
        posX: mutation.posX ?? old?.posX ?? 0,
        posY: mutation.posY ?? old?.posY ?? 0,
        posZ: mutation.posZ ?? old?.posZ ?? 0,
        ...(mutation.rotX !== undefined ? { rotX: mutation.rotX } : old?.rotX !== undefined ? { rotX: old.rotX } : {}),
        ...(mutation.scaleX !== undefined ? { scaleX: mutation.scaleX } : old?.scaleX !== undefined ? { scaleX: old.scaleX } : {}),
        ...(mutation.scaleY !== undefined ? { scaleY: mutation.scaleY } : old?.scaleY !== undefined ? { scaleY: old.scaleY } : {}),
        ...(mutation.scaleZ !== undefined ? { scaleZ: mutation.scaleZ } : old?.scaleZ !== undefined ? { scaleZ: old.scaleZ } : {})
      });
    }
  }
  return {
    ok: true,
    filePath: resolved.path,
    before,
    after,
    mutations: mutations.length,
    diagnostics: []
  };
}

function hasAnyTransform(edit: MsbPartTransformEdit): boolean {
  return edit.posX !== undefined || edit.posY !== undefined || edit.posZ !== undefined
    || edit.rotX !== undefined || edit.rotY !== undefined || edit.rotZ !== undefined
    || edit.scaleX !== undefined || edit.scaleY !== undefined || edit.scaleZ !== undefined;
}

function hasRotScale(edit: MsbPartTransformEdit): boolean {
  return edit.rotX !== undefined || edit.rotY !== undefined || edit.rotZ !== undefined
    || edit.scaleX !== undefined || edit.scaleY !== undefined || edit.scaleZ !== undefined;
}

async function resolveMsbFile(
  edit: NativeEditSession,
  file: string
): Promise<{ ok: true; path: string; mapId: string } | { ok: false; error: MsbEditFailure }> {
  const overlay = edit.session.layers.overlayRoot;
  const candidates = [
    resolve(file),
    join(overlay, file),
    join(overlay, 'map', file)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const writable = edit.session.resolveWritablePath(candidate);
      if (!writable.ok) continue;
      const mapId = basename(candidate).replace(/\.msb(\.dcx)?$/i, '');
      return { ok: true, path: candidate, mapId };
    } catch {
      // try next
    }
  }
  return {
    ok: false,
    error: { code: 'MSB_FILE_NOT_FOUND', message: `工作区内找不到地图文件：${file}（期望 mAA_BB_CC_DD.msb 或 .msb.dcx）` }
  };
}

function asDiagnostics(items: Array<{ severity: string; code: string; message: string }>): Diagnostic[] {
  return items.map((item) => ({
    severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error',
    code: item.code,
    message: item.message
  }));
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
