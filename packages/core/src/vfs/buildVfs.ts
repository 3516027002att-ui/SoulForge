/**
 * Build a VFS tree from a sandbox test workspace.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type {
  BuildVfsOptions,
  OverlayLayerId,
  ResourceFormatKind,
  ResourceKind,
  ResourceURI,
  StructuredDiagnostic,
  VfsCapability,
  VfsNode,
  VfsNodeKind,
  VfsTree
} from '@soulforge/shared';
import {
  createDiagnostic,
  createResourceUri,
  createSyntheticFixtureProvenance,
  formatResourceUri,
  syntheticFixtureConfidence
} from '@soulforge/shared';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.lua', '.hks',
  '.js', '.ts', '.csv', '.ini', '.cfg', '.toml', '.log'
]);

export async function buildVfsFromWorkspace(options: BuildVfsOptions): Promise<VfsTree> {
  const overlay: OverlayLayerId = options.overlay ?? 'overlay';
  const game = options.game ?? 'unknown';
  const createdAt = new Date().toISOString();
  const nodesByUri: Record<string, VfsNode> = {};
  const diagnostics: StructuredDiagnostic[] = [];

  const rootUri = createResourceUri({
    game,
    overlay,
    physicalPath: '.',
    resourceKind: 'other'
  });

  const children = await walkDir(options.workspaceRoot, options.workspaceRoot, {
    workspaceId: options.workspaceId,
    game,
    overlay,
    nodesByUri
  });

  // Attach synthetic event/param-like resources when marker files exist.
  const syntheticChildren = await attachSyntheticResources({
    workspaceRoot: options.workspaceRoot,
    game,
    overlay,
    nodesByUri
  });

  const root: VfsNode = {
    id: `vfs:root:${options.workspaceId}`,
    kind: 'directory',
    name: basename(options.workspaceRoot) || 'workspace',
    relativePath: '',
    absolutePath: options.workspaceRoot,
    resourceUri: rootUri,
    resourceUriString: formatResourceUri(rootUri),
    resourceKind: 'other',
    formatKind: 'unknown',
    overlay,
    capabilities: ['read', 'list'],
    diagnostics: [],
    children: [...children, ...syntheticChildren],
    nativeFormatAuthority: false
  };

  nodesByUri[root.resourceUriString] = root;

  return {
    workspaceId: options.workspaceId,
    root,
    nodesByUri,
    createdAt,
    diagnostics
  };
}

async function walkDir(
  workspaceRoot: string,
  dir: string,
  ctx: {
    workspaceId: string;
    game: string;
    overlay: OverlayLayerId;
    nodesByUri: Record<string, VfsNode>;
  }
): Promise<VfsNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes: VfsNode[] = [];

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = toPosix(relative(workspaceRoot, absolutePath));

    if (entry.isDirectory()) {
      const resourceUri = createResourceUri({
        game: ctx.game,
        overlay: ctx.overlay,
        physicalPath: relativePath || entry.name,
        resourceKind: kindFromPath(relativePath)
      });
      const childNodes = await walkDir(workspaceRoot, absolutePath, ctx);
      const node: VfsNode = {
        id: `vfs:dir:${relativePath}`,
        kind: 'directory',
        name: entry.name,
        relativePath,
        absolutePath,
        resourceUri,
        resourceUriString: formatResourceUri(resourceUri),
        resourceKind: resourceUri.resourceKind,
        formatKind: 'unknown',
        overlay: ctx.overlay,
        capabilities: ['read', 'list'],
        diagnostics: [],
        children: childNodes,
        nativeFormatAuthority: false
      };
      ctx.nodesByUri[node.resourceUriString] = node;
      nodes.push(node);
      continue;
    }

    if (!entry.isFile()) continue;
    nodes.push(await buildFileNode(workspaceRoot, absolutePath, relativePath, ctx));
  }

  return nodes;
}

async function buildFileNode(
  workspaceRoot: string,
  absolutePath: string,
  relativePath: string,
  ctx: {
    workspaceId: string;
    game: string;
    overlay: OverlayLayerId;
    nodesByUri: Record<string, VfsNode>;
  }
): Promise<VfsNode> {
  const fileStat = await stat(absolutePath);
  const bytes = await readFile(absolutePath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const extension = extname(absolutePath).toLowerCase();
  const compound = compoundExtension(relativePath);
  const resourceKind = kindFromPath(relativePath);
  const formatKind = formatFromExtension(extension, compound);
  const isText = TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(compound);
  const isJson = extension === '.json';
  const looksBinary = !isText && hasBinaryContent(bytes);

  let kind: VfsNodeKind = 'physical_file';
  let capabilities: VfsCapability[] = ['read'];
  const diagnostics = [];
  let synthetic = false;
  let provenance;
  let confidence;

  if (looksBinary || isUnsupportedPacked(compound, formatKind)) {
    kind = 'unsupported';
    capabilities = ['read', 'none'];
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'UNSUPPORTED_FORMAT',
      message: 'Binary/packed resource is indexed as unsupported in VFS scaffold.',
      details: { relativePath, formatKind, nativeFormatAuthority: false }
    }));
  } else if (isText || isJson) {
    capabilities = ['read', 'text_edit', 'stage', 'raw_edit'];
  }

  // Synthetic markers: *.synthetic.json or path under synthetic/
  if (relativePath.includes('synthetic/') || relativePath.endsWith('.synthetic.json')) {
    kind = 'synthetic_resource';
    synthetic = true;
    capabilities = ['read', 'text_edit', 'stage'];
    provenance = { sources: [createSyntheticFixtureProvenance(`vfs:${relativePath}`)] };
    confidence = syntheticFixtureConfidence();
  }

  const resourceUri: ResourceURI = createResourceUri({
    game: ctx.game,
    overlay: ctx.overlay,
    physicalPath: relativePath,
    resourceKind,
    contentHash: hash,
    version: `h:${hash.slice(0, 12)}`
  });

  // Fix diagnostic target after URI exists.
  for (const diagnostic of diagnostics) {
    diagnostic.targetUri = formatResourceUri(resourceUri);
    diagnostic.sourceUri = formatResourceUri(resourceUri);
  }

  const node: VfsNode = {
    id: `vfs:file:${relativePath}`,
    kind,
    name: basename(absolutePath),
    relativePath,
    absolutePath,
    resourceUri,
    resourceUriString: formatResourceUri(resourceUri),
    resourceKind,
    formatKind,
    overlay: ctx.overlay,
    capabilities,
    diagnostics,
    contentHash: hash,
    size: fileStat.size,
    synthetic,
    nativeFormatAuthority: false,
    metadata: { workspaceRoot }
  };
  if (provenance) node.provenance = provenance;
  if (confidence) node.confidence = confidence;

  ctx.nodesByUri[node.resourceUriString] = node;
  return node;
}

async function attachSyntheticResources(input: {
  workspaceRoot: string;
  game: string;
  overlay: OverlayLayerId;
  nodesByUri: Record<string, VfsNode>;
}): Promise<VfsNode[]> {
  const nodes: VfsNode[] = [];
  const syntheticSpecs: Array<{ name: string; kind: ResourceKind; symbolPath: string }> = [
    { name: 'event-like.synthetic.json', kind: 'event', symbolPath: 'events/synthetic/1' },
    { name: 'param-like.synthetic.json', kind: 'param', symbolPath: 'params/synthetic/1' }
  ];

  for (const spec of syntheticSpecs) {
    const absolutePath = join(input.workspaceRoot, 'synthetic', spec.name);
    try {
      await stat(absolutePath);
    } catch {
      // Create virtual synthetic node even without file — generated view.
      const resourceUri = createResourceUri({
        game: input.game,
        overlay: 'synthetic',
        physicalPath: `synthetic/${spec.name}`,
        resourceKind: spec.kind,
        symbolPath: spec.symbolPath
      });
      const node: VfsNode = {
        id: `vfs:synthetic:${spec.name}`,
        kind: 'synthetic_resource',
        name: spec.name,
        relativePath: `synthetic/${spec.name}`,
        resourceUri,
        resourceUriString: formatResourceUri(resourceUri),
        resourceKind: spec.kind,
        formatKind: 'unknown',
        overlay: 'synthetic',
        capabilities: ['read', 'stage'],
        diagnostics: [
          createDiagnostic({
            severity: 'info',
            code: 'SYNTHETIC_NOT_NATIVE',
            message: 'Synthetic resource view (not native format authority).',
            targetUri: formatResourceUri(resourceUri)
          })
        ],
        provenance: { sources: [createSyntheticFixtureProvenance(spec.name)] },
        confidence: syntheticFixtureConfidence(),
        synthetic: true,
        nativeFormatAuthority: false
      };
      input.nodesByUri[node.resourceUriString] = node;
      nodes.push(node);
    }
  }

  return nodes;
}

function kindFromPath(relativePath: string): ResourceKind {
  const first = relativePath.split(/[/\\]/)[0]?.toLowerCase();
  const map: Record<string, ResourceKind> = {
    event: 'event',
    map: 'map',
    param: 'param',
    msg: 'msg',
    menu: 'menu',
    script: 'script',
    action: 'action',
    ai: 'ai',
    sfx: 'sfx',
    chr: 'chr',
    obj: 'obj',
    other: 'other',
    synthetic: 'other'
  };
  return map[first ?? ''] ?? 'unknown';
}

function formatFromExtension(extension: string, compound: string): ResourceFormatKind {
  if (compound.endsWith('.emevd.dcx') || compound.endsWith('.emevd')) return 'emevd';
  if (compound.endsWith('.msb.dcx') || compound.endsWith('.msb')) return 'msb';
  if (compound.includes('.param')) return 'param';
  if (compound.includes('.fmg')) return 'fmg';
  if (compound.includes('.bnd')) return 'bnd';
  if (compound.endsWith('.dcx')) return 'dcx';
  if (extension === '.lua') return 'lua';
  if (extension === '.hks') return 'hks';
  if (extension === '.txt' || extension === '.json' || extension === '.md') return 'text';
  return 'unknown';
}

function compoundExtension(relativePath: string): string {
  const name = basename(relativePath).toLowerCase();
  const parts = name.split('.');
  if (parts.length <= 1) return '';
  return `.${parts.slice(1).join('.')}`;
}

function isUnsupportedPacked(compound: string, formatKind: ResourceFormatKind): boolean {
  if (['dcx', 'bnd', 'emevd', 'msb', 'param', 'fmg', 'tpf', 'gfx'].includes(formatKind)) return true;
  return compound.includes('.dcx') || compound.includes('.bnd');
}

function hasBinaryContent(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 64));
  return sample.includes(0);
}

function toPosix(pathValue: string): string {
  return pathValue.replaceAll('\\', '/');
}
