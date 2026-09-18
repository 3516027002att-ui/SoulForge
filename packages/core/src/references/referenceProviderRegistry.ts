/**
 * Resource-type capability registry for reference providers.
 * Exhaustive over ALL_RESOURCE_KINDS; missing registration fails closed in tests.
 */
import { ALL_RESOURCE_KINDS, type ResourceKind } from '@soulforge/shared';

export type ReferenceProviderSupport = 'supported' | 'partial' | 'unsupported';

export interface ReferenceProviderCapability {
  resourceKind: ResourceKind;
  formatFamilies: string[];
  support: ReferenceProviderSupport;
  relationKinds: string[];
  nativeReader?: string;
  writerSupported?: boolean;
  uncoveredReason?: string;
}

export interface ReferenceProvider {
  id: string;
  domains: string[];
  capabilities(): ReferenceProviderCapability[];
  /** Collect relations for a resolved target using injected ports. */
  collect(input: ReferenceProviderCollectInput): Promise<ReferenceProviderCollectResult>;
}

export interface ReferenceProviderCollectInput {
  targetDomain: string;
  target: unknown;
  direction: 'from' | 'to' | 'both';
  detail: 'edges' | 'context';
  depth: number;
  includeHypotheses: boolean;
  fieldIds?: string[];
  ports: ReferenceProviderPorts;
}

export interface ReferenceProviderPorts {
  readParamFields?: (input: unknown) => Promise<unknown>;
  readEmevdDocument?: (input: unknown) => Promise<unknown>;
  readScriptText?: (input: unknown) => Promise<unknown>;
  readMsbDocument?: (input: unknown) => Promise<unknown>;
  readFmgEntries?: (input: unknown) => Promise<unknown>;
  readTaeEvents?: (input: unknown) => Promise<unknown>;
  listContainerMembers?: (input: unknown) => Promise<unknown>;
  parseParamFieldRefs?: (input: unknown) => { targets: unknown[]; rejected: string[] };
  resolveEntity?: (input: unknown) => Promise<unknown>;
}

export interface ProviderRelationDraft {
  relationKind: string;
  certainty: 'confirmed' | 'indirect' | 'hypothesis';
  from: unknown;
  to: unknown;
  evidence: unknown;
  path?: unknown[];
  limitNote?: string;
}

export interface ReferenceProviderCollectResult {
  relations: ProviderRelationDraft[];
  coverageNotes: Array<{
    domain: string;
    status: 'complete' | 'partial' | 'unscanned' | 'failed' | 'unsupported' | 'skipped';
    notes?: string[];
  }>;
  diagnostics: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'error' }>;
}

export class ReferenceProviderRegistry {
  private readonly providers = new Map<string, ReferenceProvider>();

  register(provider: ReferenceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`REFERENCE_PROVIDER_DUPLICATE: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ReferenceProvider | undefined {
    return this.providers.get(id);
  }

  list(): ReferenceProvider[] {
    return [...this.providers.values()];
  }

  forDomain(domain: string): ReferenceProvider[] {
    return this.list().filter((provider) => provider.domains.includes(domain));
  }

  capabilityMatrix(): ReferenceProviderCapability[] {
    const out: ReferenceProviderCapability[] = [];
    for (const provider of this.providers.values()) {
      out.push(...provider.capabilities());
    }
    return out;
  }

  /**
   * Exhaustiveness check: every ALL_RESOURCE_KINDS value must appear.
   * Formats without semantic rules stay visible as unsupported/partial.
   */
  assertExhaustiveKinds(): void {
    const seen = new Set(this.capabilityMatrix().map((item) => item.resourceKind));
    const missing = ALL_RESOURCE_KINDS.filter((kind) => !seen.has(kind));
    if (missing.length > 0) {
      throw new Error(`REFERENCE_CAPABILITY_MATRIX_INCOMPLETE: ${missing.join(',')}`);
    }
  }
}

export function createReferenceProviderRegistry(providers: ReferenceProvider[] = []): ReferenceProviderRegistry {
  const registry = new ReferenceProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

/** Default capability rows covering every ResourceKind, including formats without semantic providers. */
export function baselineCapabilityMatrix(): ReferenceProviderCapability[] {
  return ALL_RESOURCE_KINDS.map((resourceKind) => {
    switch (resourceKind) {
      case 'param':
        return {
          resourceKind,
          formatFamilies: ['param', 'parambnd', 'gameparambnd'],
          support: 'supported',
          relationKinds: ['param_field_ref', 'param_text_link'],
          nativeReader: 'read_param_fields',
          writerSupported: true
        };
      case 'event':
        return {
          resourceKind,
          formatFamilies: ['emevd'],
          support: 'supported',
          relationKinds: ['emevd_param_arg', 'emevd_event_call', 'emevd_entity_ref'],
          nativeReader: 'read_emevd_event',
          writerSupported: true
        };
      case 'script':
      case 'ai':
        return {
          resourceKind,
          formatFamilies: ['lua', 'luabnd', 'hks'],
          support: 'supported',
          relationKinds: ['script_call', 'script_require'],
          nativeReader: 'read_script_source',
          writerSupported: true
        };
      case 'map':
        return {
          resourceKind,
          formatFamilies: ['msb'],
          support: 'supported',
          relationKinds: ['msb_param_link', 'msb_entity_instance'],
          nativeReader: 'read_msb_parts',
          writerSupported: true
        };
      case 'msg':
      case 'menu':
        return {
          resourceKind,
          formatFamilies: ['fmg', 'msgbnd'],
          support: 'supported',
          relationKinds: ['param_fmg_text'],
          nativeReader: 'read_fmg_entries',
          writerSupported: true
        };
      case 'action':
        return {
          resourceKind,
          formatFamilies: ['tae', 'anibnd'],
          support: 'partial',
          relationKinds: ['tae_motion_member'],
          nativeReader: 'read_tae_events',
          writerSupported: true,
          uncoveredReason: '未解码 TAE 参数体不产生 confirmed 语义边'
        };
      case 'chr':
      case 'obj':
      case 'sfx':
      case 'other':
        return {
          resourceKind,
          formatFamilies: ['bnd', 'chrbnd', 'objbnd', 'flver', 'tpf', 'fxr'],
          support: 'partial',
          relationKinds: ['container_member'],
          nativeReader: 'container inventory',
          writerSupported: false,
          uncoveredReason: '仅登记现有原生容器/成员连接；缺少唯一语义规则时标 coverage 缺口'
        };
      case 'unknown':
        return {
          resourceKind,
          formatFamilies: ['*'],
          support: 'unsupported',
          relationKinds: [],
          uncoveredReason: '未识别格式不伪造关系'
        };
      default:
        return {
          resourceKind,
          formatFamilies: [],
          support: 'unsupported',
          relationKinds: [],
          uncoveredReason: '未登记语义规则'
        };
    }
  });
}
