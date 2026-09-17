/** T07 资源 provider：FMG/TAE/容器确定连接适配，无语义规则即报缺口。 */
export interface FmgTextInput {
  sourceUri: string;
  childChain: string[];
  category: string;
  language?: string;
  textId: number;
  text: string;
}

export interface TaeFieldInput {
  sourceUri: string;
  childChain: string[];
  taeEntryIndex: number;
  animId: number;
  decoded: boolean;
  fields: Array<{ name: string; value: string | number | boolean }>;
}

export interface ContainerMemberInput {
  outerSourceUri: string;
  childChain: string[];
}

export function resolveFmgTextIdentity(input: FmgTextInput): string {
  if (!Number.isSafeInteger(input.textId)) throw new Error('FMG_TEXT_ID_REQUIRED');
  if (input.category.length === 0) throw new Error('FMG_CATEGORY_REQUIRED');
  const segments = [input.sourceUri, ...input.childChain, input.category, input.language ?? ''];
  for (const segment of segments) {
    if (segment.length === 0 || segment.includes('|')) throw new Error('FMG_IDENTITY_SEGMENT_INVALID');
  }
  return `${input.sourceUri}|${input.childChain.join('/')}|${input.category}|${input.language ?? ''}|${input.textId}`;
}

export function buildTaeSemanticEdges(input: TaeFieldInput): { edges: Array<{ from: string; to: string; relationKind: string; certainty: 'confirmed' }>; diagnostics: string[] } {
  // 未解码参数体不产生已确认语义边。
  if (!input.decoded) return { edges: [], diagnostics: [`undecoded-tae:${input.taeEntryIndex}:${input.animId}`] };
  return {
    edges: input.fields.map((field) => ({
      from: `${input.sourceUri}#tae${input.taeEntryIndex}:anim${input.animId}`,
      to: `tae-field:${field.name}=${String(field.value)}`,
      relationKind: 'references_motion',
      certainty: 'confirmed' as const
    })),
    diagnostics: []
  };
}

export function buildContainerMembershipEdge(input: ContainerMemberInput): { from: string; to: string; relationKind: 'member' } {
  if (input.childChain.length === 0) throw new Error('CONTAINER_CHILD_CHAIN_REQUIRED');
  for (const segment of input.childChain) {
    if (segment.length === 0 || segment.includes('|') || segment.includes('#')) {
      throw new Error('CONTAINER_CHILD_SEGMENT_INVALID');
    }
  }
  return { from: input.outerSourceUri, to: `${input.outerSourceUri}#${input.childChain.join('/')}`, relationKind: 'member' };
}

