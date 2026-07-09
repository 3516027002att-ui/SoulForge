import type { BridgeResult, ReferenceEdge } from '@soulforge/shared';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { buildReferenceGraph } from '../references/referenceBuilder.js';

export interface SyntheticConfirmedReferenceSmokeResult {
  highEdges: number;
  mediumEdges: number;
  lowEdges: number;
  found: {
    entityHigh: boolean;
    paramHigh: boolean;
    textHigh: boolean;
    flagHigh: boolean;
    bareNumericLow: boolean;
  };
}

/**
 * v0.3 reference-graph smoke for fixture-confirmed role metadata.
 *
 * Uses BridgeResult-shaped synthetic exports (not native FromSoftware binaries)
 * to prove:
 * - role-marked instruction args become high-confidence edges after ingest;
 * - bare numeric values without role stay low-confidence fallback edges.
 *
 * This does not claim native format authority.
 */
export function runSyntheticConfirmedReferenceSmoke(): SyntheticConfirmedReferenceSmokeResult {
  const index = new WorkspaceIndex('synthetic-confirmed-reference-smoke');

  const eventIngest = ingestBridgeResult(index, makeEventExport());
  if (!eventIngest.accepted) throw new Error('Synthetic event export was not ingested.');

  const mapIngest = ingestBridgeResult(index, makeMapExport());
  if (!mapIngest.accepted) throw new Error('Synthetic map export was not ingested.');

  const paramIngest = ingestBridgeResult(index, makeParamExport());
  if (!paramIngest.accepted) throw new Error('Synthetic param export was not ingested.');

  const msgIngest = ingestBridgeResult(index, makeMsgExport());
  if (!msgIngest.accepted) throw new Error('Synthetic msg export was not ingested.');

  const graph = buildReferenceGraph(index.toSymbolBundle(), { enableNumericFallback: true });
  const edges = graph.edges;
  const eventUri = 'event://m10_00_00_00/1000';

  const entityHigh = hasEdge(edges, {
    fromUri: eventUri,
    toUri: 'map://m10_00_00_00/entity/1100800',
    kind: 'references_map_entity',
    confidence: 'high'
  });
  const paramHigh = hasEdge(edges, {
    fromUri: eventUri,
    toUri: 'param://SpEffectParam/2000',
    kind: 'references_param_row',
    confidence: 'high'
  });
  const textHigh = hasEdge(edges, {
    fromUri: eventUri,
    toUri: 'msg://Goods/1000',
    kind: 'references_text',
    confidence: 'high'
  });
  const flagHigh = edges.some(
    (edge) => edge.fromUri === eventUri
      && edge.toUri === 'flag://71000000'
      && edge.confidence === 'high'
      && (edge.kind === 'reads_flag' || edge.kind === 'writes_flag')
  );
  const bareNumericLow = hasEdge(edges, {
    fromUri: eventUri,
    toUri: 'map://m10_00_00_00/entity/9999',
    kind: 'numeric_match',
    confidence: 'low'
  });

  if (!entityHigh) throw new Error('Expected high-confidence entity reference from fixture-confirmed entityId role.');
  if (!paramHigh) throw new Error('Expected high-confidence param reference from fixture-confirmed paramId role.');
  if (!textHigh) throw new Error('Expected high-confidence text reference from fixture-confirmed textId role.');
  if (!flagHigh) throw new Error('Expected high-confidence flag reference from fixture-confirmed flag role.');
  if (!bareNumericLow) throw new Error('Expected low-confidence numeric fallback for bare unmatched role.');

  // Bare numeric must never be upgraded to high just because a symbol id matches.
  const bareNumericHigh = edges.some(
    (edge) => edge.fromUri === eventUri
      && edge.toUri === 'map://m10_00_00_00/entity/9999'
      && edge.confidence === 'high'
  );
  if (bareNumericHigh) {
    throw new Error('Bare numeric match was incorrectly elevated to high confidence.');
  }

  return {
    highEdges: graph.stats.high,
    mediumEdges: graph.stats.medium,
    lowEdges: graph.stats.low,
    found: {
      entityHigh,
      paramHigh,
      textHigh,
      flagHigh,
      bareNumericLow
    }
  };
}

function hasEdge(
  edges: ReferenceEdge[],
  expected: Pick<ReferenceEdge, 'fromUri' | 'toUri' | 'kind' | 'confidence'>
): boolean {
  return edges.some(
    (edge) => edge.fromUri === expected.fromUri
      && edge.toUri === expected.toUri
      && edge.kind === expected.kind
      && edge.confidence === expected.confidence
  );
}

function makeEventExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/m10_00_00_00.synthetic.emevd',
    sourcePath: 'm10_00_00_00.synthetic.emevd',
    game: 'unknown',
    resourceKind: 'event',
    parseStatus: 'partial',
    diagnostics: [{
      severity: 'info',
      code: 'EMEVD_SYNTHETIC_FIXTURE_CONFIRMED',
      message: 'Synthetic event fixture confirmed for reference-graph plumbing.',
      sourceUri: 'file://synthetic/m10_00_00_00.synthetic.emevd',
      details: { nativeFormatAuthority: false }
    }],
    data: {
      mapId: 'm10_00_00_00',
      events: [{
        uri: 'event://m10_00_00_00/1000',
        sourceUri: 'file://synthetic/m10_00_00_00.synthetic.emevd',
        mapId: 'm10_00_00_00',
        eventId: 1000,
        name: 'synthetic_event_1000',
        instructions: [
          instruction(0, 'synthetic_instruction_flag', {
            name: 'flag',
            value: 71000000,
            role: 'flag',
            confidence: 'high'
          }),
          instruction(1, 'synthetic_instruction_entity', {
            name: 'entityId',
            value: 1100800,
            role: 'entityId',
            confidence: 'high'
          }),
          instruction(2, 'synthetic_instruction_param', {
            name: 'paramId',
            value: 2000,
            role: 'paramId',
            paramName: 'SpEffectParam',
            confidence: 'high'
          }),
          instruction(3, 'synthetic_instruction_text', {
            name: 'textId',
            value: 1000,
            role: 'textId',
            confidence: 'high'
          }),
          instruction(4, 'synthetic_instruction_bare', {
            name: 'arg0',
            value: 9999,
            role: 'unknown',
            confidence: 'low'
          })
        ],
        raw: {
          parser: 'soulforge-synthetic-event-fixture-v1',
          confidence: 'high',
          nativeFormatAuthority: false
        }
      }]
    }
  };
}

function instruction(
  index: number,
  name: string,
  arg: {
    name: string;
    value: number;
    role: 'flag' | 'entityId' | 'paramId' | 'textId' | 'unknown';
    paramName?: string;
    confidence: 'high' | 'medium' | 'low';
  }
) {
  return {
    uri: `event://m10_00_00_00/1000/instruction/${index}`,
    index,
    name,
    category: 'synthetic-fixture',
    args: [arg],
    raw: {
      parser: 'soulforge-synthetic-event-fixture-v1',
      confidence: arg.confidence,
      nativeFormatAuthority: false
    }
  };
}

function makeMapExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/m10_00_00_00.synthetic.msb',
    sourcePath: 'm10_00_00_00.synthetic.msb',
    game: 'unknown',
    resourceKind: 'map',
    parseStatus: 'partial',
    diagnostics: [{
      severity: 'info',
      code: 'MSB_SYNTHETIC_FIXTURE_CONFIRMED',
      message: 'Synthetic map fixture confirmed for reference-graph plumbing.',
      sourceUri: 'file://synthetic/m10_00_00_00.synthetic.msb',
      details: { nativeFormatAuthority: false }
    }],
    data: {
      mapId: 'm10_00_00_00',
      entities: [
        {
          uri: 'map://m10_00_00_00/entity/1100800',
          sourceUri: 'file://synthetic/m10_00_00_00.synthetic.msb',
          mapId: 'm10_00_00_00',
          entityId: 1100800,
          name: 'synthetic_entity_1100800',
          kind: 'character',
          raw: { confidence: 'high', nativeFormatAuthority: false }
        },
        {
          uri: 'map://m10_00_00_00/entity/9999',
          sourceUri: 'file://synthetic/m10_00_00_00.synthetic.msb',
          mapId: 'm10_00_00_00',
          entityId: 9999,
          name: 'synthetic_entity_9999',
          kind: 'object',
          raw: { confidence: 'high', nativeFormatAuthority: false }
        }
      ],
      regions: []
    }
  };
}

function makeParamExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/SpEffectParam.synthetic.param',
    sourcePath: 'SpEffectParam.synthetic.param',
    game: 'unknown',
    resourceKind: 'param',
    parseStatus: 'partial',
    diagnostics: [{
      severity: 'info',
      code: 'PARAM_SYNTHETIC_FIXTURE_CONFIRMED',
      message: 'Synthetic param fixture confirmed for reference-graph plumbing.',
      sourceUri: 'file://synthetic/SpEffectParam.synthetic.param',
      details: { nativeFormatAuthority: false }
    }],
    data: {
      paramName: 'SpEffectParam',
      rows: [{
        uri: 'param://SpEffectParam/2000',
        sourceUri: 'file://synthetic/SpEffectParam.synthetic.param',
        paramName: 'SpEffectParam',
        rowId: 2000,
        rowName: 'synthetic_row_2000',
        fields: [{ name: 'value', type: 'int32', value: 1 }],
        raw: { confidence: 'high', nativeFormatAuthority: false }
      }]
    }
  };
}

function makeMsgExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/Goods.synthetic.fmg',
    sourcePath: 'Goods.synthetic.fmg',
    game: 'unknown',
    resourceKind: 'msg',
    parseStatus: 'partial',
    diagnostics: [{
      severity: 'info',
      code: 'MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED',
      message: 'Synthetic msg fixture confirmed for reference-graph plumbing.',
      sourceUri: 'file://synthetic/Goods.synthetic.fmg',
      details: { nativeFormatAuthority: false }
    }],
    data: {
      category: 'Goods',
      entries: [{
        uri: 'msg://Goods/1000',
        sourceUri: 'file://synthetic/Goods.synthetic.fmg',
        category: 'Goods',
        textId: 1000,
        text: 'Synthetic text fixture',
        confidence: 'high',
        raw: { confidence: 'high', nativeFormatAuthority: false }
      }]
    }
  };
}

function main(): void {
  const result = runSyntheticConfirmedReferenceSmoke();
  console.log(JSON.stringify({
    ok: true,
    message: 'synthetic confirmed reference smoke: ok',
    ...result
  }, null, 2));
}

main();
