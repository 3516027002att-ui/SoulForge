import type { KnowledgeClaim, KnowledgeGeneration, KnowledgeLintFinding, KnowledgePage } from './knowledgeTypes.js';
import { validateClaimDependencyDag } from './claimGraph.js';

export function lintKnowledgeGeneration(generation: KnowledgeGeneration): KnowledgeLintFinding[] {
  const findings: KnowledgeLintFinding[] = [];
  const pages = Object.values(generation.pages);
  const claims = Object.values(generation.claims);
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) findings.push({ severity: 'error', code: 'DUPLICATE_PAGE_ID', message: 'pageId重复。' });
  if (new Set(claims.map((claim) => claim.claimId)).size !== claims.length) findings.push({ severity: 'error', code: 'DUPLICATE_CLAIM_ID', message: 'claimId重复。' });
  try { validateClaimDependencyDag(claims); } catch (error) { findings.push({ severity: 'error', code: error instanceof Error ? error.message : 'CLAIM_GRAPH_INVALID', message: 'claim依赖图不是合法DAG。' }); }
  for (const page of pages) lintPage(page, findings);
  for (const claim of claims) {
    if (!generation.pages[claim.pageId]) findings.push({ severity: 'error', code: 'CLAIM_PAGE_MISSING', message: `claim ${claim.claimId} 引用不存在页面。`, claimId: claim.claimId });
    if (claim.sourceRefs.length === 0) findings.push({ severity: 'error', code: 'CLAIM_SOURCE_MISSING', message: `claim ${claim.claimId} 缺少来源。`, claimId: claim.claimId });
    if (claim.scope.visibility === 'project' && !claim.scope.workspaceId) findings.push({ severity: 'error', code: 'PROJECT_SCOPE_WORKSPACE_MISSING', message: `claim ${claim.claimId} 的project scope缺少workspaceId。`, claimId: claim.claimId });
    if (claim.kind === 'observed_native' && claim.evidenceStrength !== 'native_read' && claim.publicationState === 'accepted') findings.push({ severity: 'error', code: 'NATIVE_PROOF_MISSING', message: `claim ${claim.claimId} 没有native proof。`, claimId: claim.claimId });
    if (/\b(exec|powershell|cmd|writeFile|full.?permission)\b/i.test(`${claim.text ?? ''} ${JSON.stringify(claim.value ?? '')}`)) findings.push({ severity: 'warning', code: 'EXECUTABLE_PROTOCOL_IN_KNOWLEDGE', message: `claim ${claim.claimId} 含可执行协议词，需人工复核。`, claimId: claim.claimId });
  }
  return findings;
}

function lintPage(page: KnowledgePage, findings: KnowledgeLintFinding[]): void {
  if (!page.path.startsWith('wiki/')) findings.push({ severity: 'error', code: 'PAGE_PATH_INVALID', message: `页面路径不在wiki/下：${page.path}`, pageId: page.pageId });
  if (page.scope.visibility === 'project' && !page.scope.workspaceId) findings.push({ severity: 'error', code: 'PROJECT_PAGE_WORKSPACE_MISSING', message: 'project page缺workspaceId。', pageId: page.pageId });
}
