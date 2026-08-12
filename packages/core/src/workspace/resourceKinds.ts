import {
  ALL_RESOURCE_KINDS,
  KNOWN_RESOURCE_DIRS,
  type ArtifactMarkers,
  type ResourceKind
} from '@soulforge/shared';

// 权威列表已下沉到 @soulforge/shared（renderer 可安全引用）；core 仅做 re-export + 分类逻辑。
export { ALL_RESOURCE_KINDS, KNOWN_RESOURCE_DIRS };

/**
 * CAT-05 扫描期 artifact 基础标记（§4.3）。
 *
 * 只做可机械判定的部分：大小写不敏感的 `.bak`/`.prev` 后缀、`sourceLayer`
 * 来源层、projection sidecar 的 provenance digest（调用方解析 manifest 后
 * 传入）。不解释语义——`editorCatalog.ts` 套 §4.4 注册表决定分类，且本函数
 * 不改变现有物理 `ResourceKind`。
 */
export function detectArtifactMarkers(input: {
  relativePath: string;
  sourceLayer: 'overlay' | 'base';
  recoveryOfResourceId?: string;
  projectionProvenanceDigest?: string;
}): ArtifactMarkers | undefined {
  const lower = input.relativePath.replaceAll('\\', '/').toLowerCase();
  if (lower.endsWith('.bak')) {
    return {
      artifactRole: 'backup',
      sourceLayer: input.sourceLayer,
      ...(input.recoveryOfResourceId ? { recoveryOfResourceId: input.recoveryOfResourceId } : {})
    };
  }
  if (lower.endsWith('.prev')) {
    return {
      artifactRole: 'previous',
      sourceLayer: input.sourceLayer,
      ...(input.recoveryOfResourceId ? { recoveryOfResourceId: input.recoveryOfResourceId } : {})
    };
  }
  if (input.projectionProvenanceDigest) {
    return { artifactRole: 'projection', sourceLayer: input.sourceLayer, projectionProvenanceDigest: input.projectionProvenanceDigest };
  }
  if (input.sourceLayer !== 'overlay') {
    return { artifactRole: 'base', sourceLayer: input.sourceLayer };
  }
  return undefined;
}

export function classifyResourceKind(relativePath: string): ResourceKind {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const firstSegment = normalized.split('/')[0];

  if (firstSegment && (KNOWN_RESOURCE_DIRS as readonly string[]).includes(firstSegment)) {
    return firstSegment as ResourceKind;
  }

  return classifyResourceKindByPath(normalized);
}

export function isKnownResourceKind(value: string): value is ResourceKind {
  return (ALL_RESOURCE_KINDS as readonly string[]).includes(value);
}

function classifyResourceKindByPath(normalizedPath: string): ResourceKind {
  if (normalizedPath.includes('/drawparam/') || normalizedPath.includes('/gameparam/')) return 'param';
  if (normalizedPath.includes('/talk/')) return 'script';

  if (normalizedPath.endsWith('.emevd.dcx') || normalizedPath.endsWith('.emevd')) return 'event';
  if (normalizedPath.endsWith('.msb.dcx') || normalizedPath.endsWith('.msb')) return 'map';
  if (normalizedPath.includes('param') && normalizedPath.endsWith('.dcx')) return 'param';
  if (normalizedPath.endsWith('.fmg.dcx') || normalizedPath.endsWith('.msgbnd.dcx')) return 'msg';
  if (normalizedPath.endsWith('.luabnd.dcx') || normalizedPath.endsWith('.lua')) return 'script';
  if (normalizedPath.endsWith('.gfx')) return 'menu';
  if (normalizedPath.endsWith('.ffxbnd.dcx')) return 'sfx';
  if (normalizedPath.endsWith('.txt') || normalizedPath.endsWith('.md') || normalizedPath.endsWith('.ini') || normalizedPath.endsWith('.cfg')) return 'other';

  return 'unknown';
}
