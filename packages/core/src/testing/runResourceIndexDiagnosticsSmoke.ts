/**
 * Resource graph/index health diagnostics smoke.
 */
import { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { buildResourceIndexHealthReport } from '../resource-graph/resourceIndexDiagnostics.js';

function main(): void {
  const empty = buildResourceIndexHealthReport({ workspaceId: 'ws-empty' });
  if (!empty.diagnostics.some((d) => d.code === 'RESOURCE_GRAPH_UNAVAILABLE')) {
    throw new Error('expected unavailable graph diagnostic');
  }

  const graph = new MemoryResourceGraph('ws-1');
  graph.addNode({
    id: 'n1',
    uri: 'file://a.fmg',
    kind: 'resource',
    label: 'a.fmg',
    resourceKind: 'msg'
  });
  graph.addNode({
    id: 'n2',
    uri: 'file://b.emevd',
    kind: 'resource',
    label: 'b.emevd',
    resourceKind: 'event'
  });
  graph.addEdge({
    id: 'e1',
    fromId: 'n2',
    toId: 'n1',
    kind: 'references',
    confidence: {
      level: 'low',
      score: 0.2,
      reasons: [{ code: 'heuristic', message: 'name match' }]
    }
  });

  const index = new WorkspaceIndex('ws-1');
  index.setFiles([{
    sourceUri: 'file://a.fmg',
    sourcePath: 'a.fmg',
    relativePath: 'a.fmg',
    resourceKind: 'msg',
    sizeBytes: 10,
    mtimeMs: Date.now()
  } as never]);

  const report = buildResourceIndexHealthReport({
    workspaceId: 'ws-1',
    graph,
    index
  });
  if (report.nodeCount !== 2 || report.edgeCount !== 1) {
    throw new Error(`unexpected counts nodes=${report.nodeCount} edges=${report.edgeCount}`);
  }
  if (report.candidateReferenceEdges !== 1) {
    throw new Error('expected one candidate edge');
  }
  if (!report.diagnostics.some((d) => d.code === 'RESOURCE_GRAPH_CANDIDATE_REFERENCES')) {
    throw new Error('missing candidate diagnostic');
  }
  if (report.indexFileCount < 1) {
    throw new Error('index file count missing');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '资源图/索引健康诊断验证通过',
    nodeCount: report.nodeCount,
    edgeCount: report.edgeCount,
    candidateReferenceEdges: report.candidateReferenceEdges,
    diagnosticCodes: report.diagnostics.map((d) => d.code)
  }, null, 2));
}

main();
