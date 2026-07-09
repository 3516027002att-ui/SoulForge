/**
 * High-level container APIs: inspect tree, list/read/replace children,
 * roundtrip, nested DCX(BND).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import {
  buildSyntheticBnd,
  isSyntheticBnd,
  readSyntheticBnd,
  replaceSyntheticBndChild,
  roundTripSyntheticBnd,
  toContainerChildren
} from './bndSynthetic.js';
import type {
  ChildBytesResult,
  ContainerChild,
  ContainerFormat,
  ContainerNode,
  ContainerReadResult,
  ContainerRoundTripReport,
  ContainerTree,
  ReplaceChildResult
} from './containerIr.js';
import {
  buildUnsupportedDcxStub,
  compressDcxDflt,
  decompressDcx,
  parseDcxHeader,
  recompressDcx,
  roundTripDcx
} from './dcx.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function fileUriFromPath(relativePath: string): string {
  return `file://${relativePath.replaceAll('\\', '/')}`;
}

function detectRootFormat(bytes: Buffer): ContainerFormat {
  if (bytes.length >= 4) {
    if (bytes.subarray(0, 4).equals(Buffer.from('DCX\0', 'ascii'))) return 'dcx';
    const magic = bytes.subarray(0, 4).toString('ascii');
    if (magic === 'BND4') return 'bnd4';
    if (magic === 'BND3') return 'bnd3';
  }
  return 'raw';
}

function parseChildUri(childUri: string): {
  containerUri: string;
  segments: string[];
  childName: string;
} {
  const hash = childUri.indexOf('#');
  if (hash < 0) {
    return { containerUri: childUri, segments: [], childName: '' };
  }
  const containerUri = childUri.slice(0, hash);
  const fragment = childUri.slice(hash + 1);
  const parts = fragment.split('/').filter(Boolean);
  // e.g. dcx/bnd/child/item.fmg  or  bnd/child/item.fmg
  const childIdx = parts.lastIndexOf('child');
  const childName = childIdx >= 0 && parts[childIdx + 1]
    ? decodeURIComponent(parts[childIdx + 1]!)
    : decodeURIComponent(parts[parts.length - 1] ?? '');
  return { containerUri, segments: parts, childName };
}

/**
 * Inspect a container file into a ContainerTree (recursive for DCX→BND).
 */
export async function inspectContainerTree(
  absolutePath: string,
  options?: { relativePath?: string; maxDepth?: number }
): Promise<ContainerReadResult> {
  const diagnostics: StructuredDiagnostic[] = [];
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'CONTAINER_READ_FAILED',
        message: error instanceof Error ? error.message : 'Failed to read container.'
      })]
    };
  }

  const relativePath = options?.relativePath ?? absolutePath.replaceAll('\\', '/');
  const rootUri = fileUriFromPath(relativePath);
  const maxDepth = options?.maxDepth ?? 4;
  const root = inspectBytes(bytes, rootUri, '', maxDepth, diagnostics);
  const flatChildren = flattenChildren(root);

  const tree: ContainerTree = {
    rootUri,
    rootPath: absolutePath,
    rootHash: sha256(bytes),
    root,
    flatChildren,
    diagnostics
  };

  return {
    ok: root.format !== 'unknown' || bytes.length > 0,
    tree,
    diagnostics
  };
}

function flattenChildren(node: ContainerNode): ContainerChild[] {
  const out: ContainerChild[] = [...node.children];
  if (node.payload) {
    out.push(...flattenChildren(node.payload));
  }
  for (const child of node.children) {
    // nested children only via payload recursion for DCX
  }
  return out;
}

function inspectBytes(
  bytes: Buffer,
  uri: string,
  pathPrefix: string,
  depth: number,
  diagnostics: StructuredDiagnostic[]
): ContainerNode {
  const format = detectRootFormat(bytes);
  const hash = sha256(bytes);
  const base: ContainerNode = {
    uri,
    format,
    authority: 'none',
    magic: bytes.length >= 4 ? bytes.subarray(0, 4).toString('ascii') : '',
    size: bytes.length,
    hash,
    children: [],
    metadata: {},
    diagnostics: [],
    containerRoundTripSafe: false,
    decompressionStatus: 'none',
    compressionStatus: 'none',
    canListChildren: false,
    canReadChild: false,
    canReplaceChild: false,
    canRepackContainer: false
  };

  if (format === 'dcx') {
    const header = parseDcxHeader(bytes);
    diagnostics.push(...header.diagnostics);
    base.metadata = {
      ...(header.header ?? {}),
      compressionKind: header.header?.compressionKind
    };
    if (!header.header?.boundaryConfirmed) {
      base.decompressionStatus = 'failed';
      base.authority = 'candidate';
      return base;
    }
    if (header.header.compressionKind !== 'DFLT') {
      base.decompressionStatus = 'unsupported';
      base.compressionStatus = 'unsupported';
      base.authority = 'partial';
      base.diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'DCX_COMPRESSION_UNSUPPORTED',
        message: `DCX ${header.header.compressionKind} decompress unsupported; raw-level still available.`
      }));
      return base;
    }

    const decomp = decompressDcx(bytes);
    diagnostics.push(...decomp.diagnostics);
    base.decompressionStatus = decomp.decompressionStatus;
    base.compressionStatus = decomp.ok ? 'supported' : 'failed';
    base.authority = decomp.ok ? 'partial' : 'none';

    if (decomp.ok && decomp.payload && depth > 0) {
      const payloadUri = `${uri}#dcx/payload`;
      const payloadNode = inspectBytes(
        decomp.payload,
        payloadUri,
        pathPrefix ? `${pathPrefix}/dcx` : 'dcx',
        depth - 1,
        diagnostics
      );
      base.payload = payloadNode;
      // Promote nested BND children to this DCX node for convenient listing
      if (payloadNode.format === 'bnd3' || payloadNode.format === 'bnd4') {
        base.children = payloadNode.children.map((c) => ({
          ...c,
          sourceContainerUri: uri,
          childUri: c.childUri.includes('#')
            ? `${uri}#dcx/${c.childUri.split('#').pop()}`
            : `${uri}#dcx/bnd/child/${encodeURIComponent(c.name ?? c.childId)}`,
          canReplace: payloadNode.canReplaceChild
        }));
        base.canListChildren = payloadNode.canListChildren;
        base.canReadChild = payloadNode.canReadChild;
        base.canReplaceChild = payloadNode.canReplaceChild;
        base.canRepackContainer = payloadNode.canRepackContainer && base.compressionStatus === 'supported';
        base.containerRoundTripSafe =
          payloadNode.containerRoundTripSafe && base.compressionStatus === 'supported';
        base.authority = base.containerRoundTripSafe ? 'fixture-confirmed' : 'partial';
      } else {
        base.canListChildren = false;
        base.canReadChild = true; // can read decompressed payload as whole
        base.canReplaceChild = false;
        base.canRepackContainer = base.compressionStatus === 'supported';
        base.containerRoundTripSafe = base.compressionStatus === 'supported';
        base.authority = 'partial';
      }
    }
    return base;
  }

  if (format === 'bnd3' || format === 'bnd4') {
    if (!isSyntheticBnd(bytes)) {
      base.authority = 'candidate';
      base.canListChildren = false;
      base.canReplaceChild = false;
      base.canRepackContainer = false;
      base.diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'BND_NATIVE_NOT_AUTHORITATIVE',
        message: 'Native BND without SFBN marker: container child replace blocked. Raw-level only.'
      }));
      diagnostics.push(...base.diagnostics);
      return base;
    }

    const read = readSyntheticBnd(bytes);
    diagnostics.push(...read.diagnostics);
    if (!read.ok) {
      base.authority = 'none';
      return base;
    }

    const prefix = pathPrefix ? `${pathPrefix}/bnd` : 'bnd';
    base.children = toContainerChildren(uri, read, prefix);
    base.authority = 'fixture-confirmed';
    base.canListChildren = true;
    base.canReadChild = true;
    base.canReplaceChild = true;
    base.canRepackContainer = true;
    base.containerRoundTripSafe = true;
    base.metadata = {
      parser: 'soulforge-synthetic-binder-fixture-v1',
      nativeFormatAuthority: false,
      childCount: read.children.length,
      format: read.format
    };
    return base;
  }

  base.format = format === 'raw' ? 'raw' : format;
  return base;
}

export async function listContainerChildren(
  absolutePath: string,
  options?: { relativePath?: string; recursive?: boolean }
): Promise<{ ok: boolean; children: ContainerChild[]; diagnostics: StructuredDiagnostic[] }> {
  const tree = await inspectContainerTree(absolutePath, options);
  if (!tree.ok || !tree.tree) {
    return { ok: false, children: [], diagnostics: tree.diagnostics };
  }
  const children = options?.recursive
    ? tree.tree.flatChildren
    : tree.tree.root.children;
  return { ok: true, children, diagnostics: tree.diagnostics };
}

export async function readContainerChild(
  absolutePath: string,
  childUri: string,
  options?: { relativePath?: string }
): Promise<ChildBytesResult> {
  const bytes = await readFile(absolutePath);
  const rootUri = fileUriFromPath(options?.relativePath ?? absolutePath.replaceAll('\\', '/'));
  const parsed = parseChildUri(childUri);
  return readChildFromBytes(bytes, rootUri, parsed.childName, parsed.segments);
}

function readChildFromBytes(
  bytes: Buffer,
  rootUri: string,
  childName: string,
  segments: string[]
): ChildBytesResult {
  const diagnostics: StructuredDiagnostic[] = [];
  const format = detectRootFormat(bytes);

  // Nested DCX → BND → child
  if (format === 'dcx') {
    const decomp = decompressDcx(bytes);
    diagnostics.push(...decomp.diagnostics);
    if (!decomp.ok || !decomp.payload) {
      return { ok: false, childUri: `${rootUri}#...`, diagnostics };
    }
    return readChildFromBytes(decomp.payload, rootUri, childName, segments.filter((s) => s !== 'dcx' && s !== 'payload'));
  }

  if (format === 'bnd3' || format === 'bnd4') {
    const read = readSyntheticBnd(bytes);
    diagnostics.push(...read.diagnostics);
    if (!read.ok) {
      return { ok: false, childUri: `${rootUri}#bnd/child/${childName}`, diagnostics };
    }
    const child = read.children.find((c) =>
      c.name === childName || String(c.id) === childName
    );
    if (!child) {
      return {
        ok: false,
        childUri: `${rootUri}#bnd/child/${encodeURIComponent(childName)}`,
        diagnostics: [
          ...diagnostics,
          createDiagnostic({
            severity: 'error',
            code: 'BND_CHILD_NOT_FOUND',
            message: `Child not found: ${childName}`
          })
        ]
      };
    }
    return {
      ok: true,
      childUri: `${rootUri}#bnd/child/${encodeURIComponent(child.name)}`,
      bytes: child.bytes,
      hash: child.hash,
      diagnostics
    };
  }

  return {
    ok: false,
    childUri: `${rootUri}#${childName}`,
    diagnostics: [createDiagnostic({
      severity: 'error',
      code: 'CONTAINER_FORMAT_UNSUPPORTED',
      message: 'Not a supported container for child read.'
    })]
  };
}

/**
 * Replace a child and rebuild the outer container (in-memory).
 * Supports: synthetic BND, DCX(DFLT) wrapping synthetic BND.
 */
export function replaceContainerChildInMemory(
  containerBytes: Buffer,
  childSelector: string,
  newChildBytes: Buffer,
  expectedContainerHash: string,
  expectedChildHash: string
): ReplaceChildResult {
  const diagnostics: StructuredDiagnostic[] = [];
  const actualHash = sha256(containerBytes);
  if (actualHash !== expectedContainerHash) {
    return {
      ok: false,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'HASH_MISMATCH',
        message: 'expectedContainerHash does not match container bytes.',
        details: { expected: expectedContainerHash, actual: actualHash }
      })]
    };
  }

  const format = detectRootFormat(containerBytes);

  if (format === 'bnd3' || format === 'bnd4') {
    // Verify child hash first
    const read = readSyntheticBnd(containerBytes);
    if (!read.ok) {
      return { ok: false, diagnostics: read.diagnostics };
    }
    const child = read.children.find((c) =>
      c.name === childSelector || String(c.id) === childSelector
    );
    if (!child) {
      return {
        ok: false,
        diagnostics: [createDiagnostic({
          severity: 'error',
          code: 'BND_CHILD_NOT_FOUND',
          message: `Child not found: ${childSelector}`
        })]
      };
    }
    if (child.hash !== expectedChildHash) {
      return {
        ok: false,
        diagnostics: [createDiagnostic({
          severity: 'error',
          code: 'HASH_MISMATCH',
          message: 'expectedChildHash does not match current child.',
          details: { expected: expectedChildHash, actual: child.hash }
        })]
      };
    }
    const replaced = replaceSyntheticBndChild(containerBytes, childSelector, newChildBytes);
    if (!replaced.ok || !replaced.bytes) {
      return { ok: false, diagnostics: replaced.diagnostics };
    }
    const report = roundTripSyntheticBnd(replaced.bytes);
    const out: ReplaceChildResult = {
      ok: true,
      containerBytes: replaced.bytes,
      report,
      diagnostics: [...diagnostics, ...replaced.diagnostics]
    };
    if (replaced.hash !== undefined) out.containerHash = replaced.hash;
    if (replaced.newChildHash !== undefined) out.newChildHash = replaced.newChildHash;
    return out;
  }

  if (format === 'dcx') {
    const decomp = decompressDcx(containerBytes);
    diagnostics.push(...decomp.diagnostics);
    if (!decomp.ok || !decomp.payload) {
      return { ok: false, diagnostics };
    }
    if (decomp.header?.compressionKind !== 'DFLT') {
      return {
        ok: false,
        diagnostics: [
          ...diagnostics,
          createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_REPACK_BLOCKED',
            message: 'Cannot authoritative-repack non-DFLT DCX; use raw replace.'
          })
        ]
      };
    }

    // Replace inside decompressed payload (synthetic BND), using payload hash as container precondition.
    const payloadHash = sha256(decomp.payload);
    const inner = replaceContainerChildInMemory(
      decomp.payload,
      childSelector,
      newChildBytes,
      payloadHash,
      expectedChildHash
    );
    if (!inner.ok || !inner.containerBytes) {
      return { ok: false, diagnostics: [...diagnostics, ...inner.diagnostics] };
    }

    const re = recompressDcx(inner.containerBytes, containerBytes);
    diagnostics.push(...re.diagnostics);
    if (!re.ok || !re.bytes) {
      return { ok: false, diagnostics };
    }

    const verify = decompressDcx(re.bytes);
    if (!verify.ok || !verify.payload) {
      return {
        ok: false,
        diagnostics: [
          ...diagnostics,
          createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_NESTED_VERIFY_FAILED',
            message: 'Failed to re-decompress rebuilt DCX.'
          })
        ]
      };
    }
    const verifyChild = readChildFromBytes(verify.payload, 'file://nested', childSelector, ['bnd']);
    if (!verifyChild.ok || verifyChild.hash !== sha256(newChildBytes)) {
      return {
        ok: false,
        diagnostics: [
          ...diagnostics,
          ...verifyChild.diagnostics,
          createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_CHILD_VERIFY_FAILED',
            message: 'Rebuilt nested container does not contain expected child hash.'
          })
        ]
      };
    }

    const report: ContainerRoundTripReport = {
      ok: true,
      byteIdentical: re.byteIdenticalToOriginal === true,
      payloadEquivalent: true,
      originalHash: actualHash,
      rebuiltHash: re.hash ?? sha256(re.bytes),
      childHashMatches: true,
      diagnostics
    };
    if (decomp.payloadHash !== undefined) report.originalPayloadHash = decomp.payloadHash;
    if (verify.payloadHash !== undefined) report.rebuiltPayloadHash = verify.payloadHash;
    const out: ReplaceChildResult = {
      ok: true,
      containerBytes: re.bytes,
      newChildHash: sha256(newChildBytes),
      report,
      diagnostics
    };
    if (re.hash !== undefined) out.containerHash = re.hash;
    return out;
  }

  return {
    ok: false,
    diagnostics: [createDiagnostic({
      severity: 'error',
      code: 'CONTAINER_FORMAT_UNSUPPORTED',
      message: 'Container format does not support authoritative child replace.',
      details: { format }
    })]
  };
}

export async function roundTripContainer(
  absolutePath: string
): Promise<ContainerRoundTripReport> {
  const bytes = await readFile(absolutePath);
  const format = detectRootFormat(bytes);
  if (format === 'dcx') {
    return roundTripDcx(bytes);
  }
  if (format === 'bnd3' || format === 'bnd4') {
    return roundTripSyntheticBnd(bytes);
  }
  return {
    ok: false,
    byteIdentical: false,
    payloadEquivalent: false,
    originalHash: sha256(bytes),
    rebuiltHash: '',
    childHashMatches: false,
    diagnostics: [createDiagnostic({
      severity: 'error',
      code: 'CONTAINER_FORMAT_UNSUPPORTED',
      message: `Roundtrip not supported for format ${format}.`
    })]
  };
}

export async function validateContainer(absolutePath: string): Promise<{
  ok: boolean;
  format: ContainerFormat;
  diagnostics: StructuredDiagnostic[];
  report?: ContainerRoundTripReport;
}> {
  const bytes = await readFile(absolutePath);
  const format = detectRootFormat(bytes);
  const tree = await inspectContainerTree(absolutePath);
  const report = await roundTripContainer(absolutePath);
  return {
    ok: tree.ok && (format === 'raw' || report.ok || report.diagnostics.some((d) => d.code === 'DCX_COMPRESSION_UNSUPPORTED')),
    format,
    diagnostics: [...tree.diagnostics, ...report.diagnostics],
    report
  };
}

export async function exportContainerTree(
  absolutePath: string,
  outputDirectory: string,
  options?: { relativePath?: string }
): Promise<{ ok: boolean; exported: string[]; diagnostics: StructuredDiagnostic[] }> {
  const list = await listContainerChildren(absolutePath, { ...options, recursive: true });
  if (!list.ok) {
    return { ok: false, exported: [], diagnostics: list.diagnostics };
  }
  const exported: string[] = [];
  for (const child of list.children) {
    const read = await readContainerChild(absolutePath, child.childUri, options);
    if (!read.ok || !read.bytes) continue;
    const name = child.name ?? child.childId;
    const outPath = join(outputDirectory, name.replaceAll(/[\\/]/g, '_'));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, read.bytes);
    exported.push(outPath);
  }
  return { ok: true, exported, diagnostics: list.diagnostics };
}

/** Test helpers re-export */
export {
  buildSyntheticBnd,
  compressDcxDflt,
  buildUnsupportedDcxStub,
  decompressDcx,
  isSyntheticBnd,
  readSyntheticBnd
};
