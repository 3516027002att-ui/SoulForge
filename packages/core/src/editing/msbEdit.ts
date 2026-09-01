/**
 * Agent / CLI MSB facade（问题 6-F）。
 *
 * 读：read-msb-document。写：将 part 变换 lowering 为统一的
 * MapEditTransaction → Patch Engine → native reread 路径。
 *
 * 入参是地址字符串（m11_01_00_00#c1050_0000），内部 parseMapAddress。未解码的
 * 其他 MSB 字段不开放 set。
 */
import { access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Diagnostic } from '@soulforge/shared';
import { formatMapAddress, parseMapAddress } from '@soulforge/shared';
import { executeMapTransaction } from './mapService.js';
import { readMsbDocumentViaBridge } from './msbBridgeRead.js';
import type { NativeEditSession } from './nativeEditSession.js';

export interface MsbPartSnapshot {
  address: string;
  name: string;
  family: 'part';
  nativeOffset: number;
  typeId: number;
  mapId: string;
  posX: number;
  posY: number;
  posZ: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export interface MsbPartTransformEdit {
  /** `m11_01_00_00#c1050_0000`。 */
  address: string;
  /** Native identity is mandatory for writes; address/name is diagnostic context only. */
  nativeOffset?: number;
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
  | { ok: true; filePath: string; mapId: string; sourceUri: string; sourceHash: string; parts: MsbPartSnapshot[]; diagnostics: Diagnostic[] }
  | { ok: false; error: MsbEditFailure; diagnostics: Diagnostic[] };

export type MsbSetResult =
  | { ok: true; filePath: string; before: MsbPartSnapshot[]; after: MsbPartSnapshot[]; mutations: number; diagnostics: Diagnostic[] }
  | { ok: false; error: MsbEditFailure; diagnostics: Diagnostic[]; before?: MsbPartSnapshot[] };

/** 只写变换变体（set_part_position / set_part_transform），不含 delete。 */
interface MsbTransformMutation {
  kind: 'set_part_position' | 'set_part_transform';
  family: 'part';
  nativeOffset: number;
  expectedName: string;
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
    family: 'part' as const,
    nativeOffset: requireNativeOffset(part.nativeOffset, part.name),
    typeId: part.typeId,
    mapId,
    posX: part.posX,
    posY: part.posY,
    posZ: part.posZ,
    ...(part.rotX !== undefined ? { rotX: part.rotX } : {}),
    ...(part.rotY !== undefined ? { rotY: part.rotY } : {}),
    ...(part.rotZ !== undefined ? { rotZ: part.rotZ } : {}),
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
  return {
    ok: true,
    filePath: resolved.path,
    mapId,
    sourceUri: `map://${mapId}/${basename(resolved.path)}`,
    sourceHash: doc.data.sourceHash,
    parts: selected,
    diagnostics: asDiagnostics(doc.diagnostics)
  };
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
    if (edit.nativeOffset === undefined) {
      return {
        ok: false,
        error: { code: 'MSB_NATIVE_OFFSET_REQUIRED', message: `写入目标必须携带 nativeOffset：${edit.address}` },
        diagnostics: []
      };
    }
    // Native offset is the identity.  Name is only an expected-name guard and
    // diagnostic context; finding by name first is ambiguous for legitimate
    // duplicate MSB names and can select the wrong entity.
    const part = doc.data.parts.find((item) => item.nativeOffset === edit.nativeOffset);
    if (!part) {
      return {
        ok: false,
        error: {
          code: 'MSB_NATIVE_IDENTITY_NOT_FOUND',
          message: `nativeOffset 不存在：${edit.nativeOffset}（expectedName=${parsed.name}，文件 ${resolved.path}）`
        },
        diagnostics: []
      };
    }
    if (part.name !== parsed.name) {
      return {
        ok: false,
        error: {
          code: 'MSB_NATIVE_IDENTITY_MISMATCH',
          message: `nativeOffset 与 expectedName 不匹配：offset=${edit.nativeOffset} expectedName=${parsed.name} actualName=${part.name}`
        },
        diagnostics: []
      };
    }
    const nativeOffset = requireNativeOffset(part.nativeOffset, part.name);
    if (!hasAnyTransform(edit)) {
      return { ok: false, error: { code: 'MSB_EDIT_EMPTY', message: `${edit.address} 没有任何要写入的变换字段。` }, diagnostics: [] };
    }
    before.push({
      address: formatMapAddress({ block: resolved.mapId, name: part.name }),
      name: part.name,
      family: 'part',
      nativeOffset,
      typeId: part.typeId,
      mapId: resolved.mapId,
      posX: part.posX ?? 0,
      posY: part.posY ?? 0,
      posZ: part.posZ ?? 0,
      ...(part.rotX !== undefined ? { rotX: part.rotX } : {}),
      ...(part.rotY !== undefined ? { rotY: part.rotY } : {}),
      ...(part.rotZ !== undefined ? { rotZ: part.rotZ } : {}),
      ...(part.scaleX !== undefined ? { scaleX: part.scaleX } : {}),
      ...(part.scaleY !== undefined ? { scaleY: part.scaleY } : {}),
      ...(part.scaleZ !== undefined ? { scaleZ: part.scaleZ } : {})
    });
    const mutation: MsbTransformMutation = {
      kind: hasRotScale(edit) ? 'set_part_transform' : 'set_part_position',
      family: 'part',
      nativeOffset,
      expectedName: parsed.name,
      ...(edit.posX !== undefined ? { posX: edit.posX } : {}),
      ...(edit.posY !== undefined ? { posY: edit.posY } : {}),
      ...(edit.posZ !== undefined ? { posZ: edit.posZ } : {}),
      ...(edit.rotX !== undefined ? { rotX: edit.rotX } : {}),
      ...(edit.rotY !== undefined ? { rotY: edit.rotY } : {}),
      ...(edit.rotZ !== undefined ? { rotZ: edit.rotZ } : {}),
      ...(edit.scaleX !== undefined ? { scaleX: edit.scaleX } : {}),
      ...(edit.scaleY !== undefined ? { scaleY: edit.scaleY } : {}),
      ...(edit.scaleZ !== undefined ? { scaleZ: edit.scaleZ } : {})
    };
    mutations.push(mutation);
  }

  const file = await input.edit.indexFile(resolved.path, 'map');
  const expectedHash = file.sha256 || doc.data.sourceHash;
  const beforeByOffset = new Map(before.map((snapshot) => [snapshot.nativeOffset, snapshot]));
  const transaction = {
    id: `tx-msb-transform-${Date.now()}`,
    mapId: resolved.mapId,
    baseRevision: expectedHash,
    description: `MSB transform (${mutations.length} 个 part)`,
    author: 'human' as const,
    operations: mutations.map((mutation) => {
      const snapshot = beforeByOffset.get(mutation.nativeOffset);
      if (!snapshot) throw new Error(`MSB_NATIVE_IDENTITY_NOT_FOUND: ${mutation.nativeOffset}`);
      return {
        kind: 'set_transform' as const,
        target: `part:${resolved.mapId}:offset-${mutation.nativeOffset.toString(16)}`,
        ...(mutation.posX !== undefined || mutation.posY !== undefined || mutation.posZ !== undefined
          ? { position: [mutation.posX ?? snapshot.posX, mutation.posY ?? snapshot.posY, mutation.posZ ?? snapshot.posZ] as [number, number, number] }
          : {}),
        ...(mutation.rotX !== undefined || mutation.rotY !== undefined || mutation.rotZ !== undefined
          ? { rotation: [mutation.rotX ?? snapshot.rotX ?? 0, mutation.rotY ?? snapshot.rotY ?? 0, mutation.rotZ ?? snapshot.rotZ ?? 0] as [number, number, number] }
          : {}),
        ...(mutation.scaleX !== undefined || mutation.scaleY !== undefined || mutation.scaleZ !== undefined
          ? { scale: [mutation.scaleX ?? snapshot.scaleX ?? 1, mutation.scaleY ?? snapshot.scaleY ?? 1, mutation.scaleZ ?? snapshot.scaleZ ?? 1] as [number, number, number] }
          : {})
      };
    }),
    timestamp: Date.now()
  };
  const outcome = await executeMapTransaction(input.edit, resolved.path, transaction);
  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error ?? { code: 'MSB_WRITE_FAILED', message: 'MSB 写入失败。' },
      diagnostics: outcome.error?.details && Array.isArray(outcome.error.details)
        ? outcome.error.details as Diagnostic[]
        : [],
      before
    };
  }

  // executeMapTransaction 已经完成 authoritative reread；这里再次投影
  // 仅用于维持 facade 的 before/after 返回契约，不参与成功判定。
  const after: MsbPartSnapshot[] = [];
  const reread = await readMsbDocumentViaBridge({
    sourcePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (reread.ok && reread.data) {
    for (const mutation of mutations) {
      const part = reread.data.parts.find((item) => item.nativeOffset === mutation.nativeOffset);
      if (!part) {
        return {
          ok: false,
          error: { code: 'MSB_REREAD_FAILED', message: `写入后 nativeOffset ${mutation.nativeOffset} 无法读回。` },
          diagnostics: asDiagnostics(reread.diagnostics),
          before
        };
      }
      if (part.name !== mutation.expectedName) {
        return {
          ok: false,
          error: { code: 'MSB_NATIVE_IDENTITY_MISMATCH', message: `写入后 expectedName 不匹配：offset=${mutation.nativeOffset} expectedName=${mutation.expectedName} actualName=${part.name}` },
          diagnostics: asDiagnostics(reread.diagnostics),
          before
        };
      }
      const nativeOffset = requireNativeOffset(part.nativeOffset, part.name);
      after.push({
        address: formatMapAddress({ block: resolved.mapId, name: part.name }),
        name: part.name,
        family: 'part',
        nativeOffset,
        typeId: part.typeId,
        mapId: resolved.mapId,
        posX: part.posX,
        posY: part.posY,
        posZ: part.posZ,
        ...(part.rotX !== undefined ? { rotX: part.rotX } : {}),
        ...(part.rotY !== undefined ? { rotY: part.rotY } : {}),
        ...(part.rotZ !== undefined ? { rotZ: part.rotZ } : {}),
        ...(part.scaleX !== undefined ? { scaleX: part.scaleX } : {}),
        ...(part.scaleY !== undefined ? { scaleY: part.scaleY } : {}),
        ...(part.scaleZ !== undefined ? { scaleZ: part.scaleZ } : {})
      });
    }
  } else {
    return {
      ok: false,
      error: { code: 'MSB_REREAD_FAILED', message: `写入后无法重新读取 MSB：${resolved.path}` },
      diagnostics: asDiagnostics(reread.diagnostics),
      before
    };
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

function requireNativeOffset(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`MSB_NATIVE_OFFSET_REQUIRED: part ${name} 缺少有效 nativeOffset。`);
  }
  return value;
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
