import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { ResourceMode } from './resourceFamilies.js';

/**
 * 顶层工作域。这里刻意不复用 ResourceKind：目录分类是索引实现细节，
 * 工作域是用户任务模型；二者不能互相泄漏到导航栏。
 */
export type EditorDomainId =
  | 'project'
  | 'param'
  | 'gparam'
  | 'text'
  | 'event'
  | 'map'
  | 'script'
  | 'behavior'
  | 'animation'
  | 'model'
  | 'texture'
  | 'material'
  | 'vfx'
  | 'container'
  | 'files';

export interface DomainNavigationItem {
  id: EditorDomainId;
  label: string;
  description: string;
}

export const DOMAIN_NAV_ITEMS: readonly DomainNavigationItem[] = [
  { id: 'project', label: '项目', description: '工作区与项目状态' },
  { id: 'param', label: 'PARAM', description: 'PARAM 表与行字段' },
  { id: 'gparam', label: 'GPARAM', description: '全局参数表（待接入）' },
  { id: 'text', label: '文本', description: '语言、容器、FMG 与条目' },
  { id: 'event', label: '事件', description: '事件源码、结构与问题' },
  { id: 'map', label: '地图', description: 'MSB 场景与地图资源' },
  { id: 'script', label: '脚本', description: '脚本与动作容器' },
  { id: 'behavior', label: '行为', description: '行为图与行为资源' },
  { id: 'animation', label: '动画', description: '动画与 TAE 资源' },
  { id: 'model', label: '模型', description: 'FLVER 模型资源' },
  { id: 'texture', label: '纹理', description: 'TPF 纹理资源' },
  { id: 'material', label: '材质', description: '材质资源' },
  { id: 'vfx', label: 'VFX', description: '特效资源' },
  { id: 'container', label: '容器', description: 'BND/DCX 容器资源' },
  { id: 'files', label: '文件', description: '全部已索引文件' }
] as const;

const EXTENSIONS: Record<Exclude<EditorDomainId, 'project' | 'gparam' | 'text' | 'event' | 'map' | 'script' | 'param' | 'container' | 'files'>, readonly string[]> = {
  behavior: ['.beh', '.hkx', '.behavior'],
  animation: ['.tae', '.anibnd'],
  model: ['.flver'],
  texture: ['.tpf', '.dds'],
  material: ['.mat', '.mtd'],
  vfx: ['.ffx', '.fxr', '.vfx']
};

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const normalized = path.toLowerCase();
  return extensions.some((extension) => normalized.endsWith(extension));
}

function isContainerFile(file: RendererIndexedFile): boolean {
  const path = file.relativePath.toLowerCase();
  return file.formatKind === 'bnd'
    || file.formatKind === 'dcx'
    || file.compoundExtension.toLowerCase().includes('.bnd')
    || file.compoundExtension.toLowerCase().includes('.dcx')
    || path.endsWith('.parambnd')
    || path.endsWith('.parambnd.dcx')
    || path.endsWith('.parambnd.dcx.bak');
}

/** 根据文件推断其用户工作域；只用于打开文件后的选中态，不改变资源分类。 */
export function domainForFile(file: RendererIndexedFile): EditorDomainId {
  if (file.resourceKind === 'param') return 'param';
  if (file.resourceKind === 'msg' || file.resourceKind === 'menu' || file.formatKind === 'fmg') return 'text';
  if (file.resourceKind === 'event' || file.formatKind === 'emevd') return 'event';
  if (file.resourceKind === 'map' || file.formatKind === 'msb') return 'map';
  if (file.resourceKind === 'script' || file.resourceKind === 'action' || file.formatKind === 'lua' || file.formatKind === 'hks') return 'script';
  if (isContainerFile(file)) return 'container';
  const path = file.relativePath.toLowerCase();
  for (const [domain, extensions] of Object.entries(EXTENSIONS) as Array<[Exclude<EditorDomainId, 'project' | 'gparam' | 'text' | 'event' | 'map' | 'script' | 'param' | 'container' | 'files'>, readonly string[]]>) {
    if (hasExtension(path, extensions)) return domain;
  }
  return 'files';
}

export function resourceModeForDomain(domain: EditorDomainId): ResourceMode {
  if (domain === 'param' || domain === 'event' || domain === 'map' || domain === 'script') return domain;
  if (domain === 'text') return 'msg';
  return 'all';
}

export function domainMatchesFile(file: RendererIndexedFile, domain: EditorDomainId): boolean {
  if (domain === 'project' || domain === 'gparam') return false;
  if (domain === 'files') return true;
  if (domain === 'container') return isContainerFile(file);
  return domainForFile(file) === domain;
}

export function filterFilesForDomain(
  files: RendererIndexedFile[],
  domain: EditorDomainId,
  query: string
): RendererIndexedFile[] {
  const normalized = query.trim().toLowerCase();
  return files.filter((file) => {
    if (!domainMatchesFile(file, domain)) return false;
    if (!normalized) return true;
    return file.relativePath.toLowerCase().includes(normalized)
      || file.resourceKind.toLowerCase().includes(normalized)
      || file.formatLabel.toLowerCase().includes(normalized);
  });
}

export function domainLabel(domain: EditorDomainId): string {
  return DOMAIN_NAV_ITEMS.find((item) => item.id === domain)?.label ?? domain;
}
