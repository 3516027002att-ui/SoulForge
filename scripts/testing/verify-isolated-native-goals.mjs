/** Fresh read-only domain session. Raw native results are asserted here before
 * any model-envelope truncation or report redaction can affect the verdict. */
import { openLocalCliSession } from '../../packages/core/dist/index.js';
import { verifyGoalsThroughNativeTool } from '../real-agent-evaluator.mjs';
import { parseGoalContract } from '../real-agent-goal-contract.mjs';
import { fileURLToPath } from 'node:url';
import { decodeTaskInput, captureVerifierArtifact } from './agent-run-provenance.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const verifierInputs = ['packages/core/dist','packages/shared/dist','bridge/SoulForge.Bridge/bin',
  'scripts/testing/verify-isolated-native-goals.mjs','scripts/testing/agent-run-provenance.mjs',
  'scripts/real-agent-evaluator.mjs','scripts/real-agent-harness-lib.mjs','scripts/real-agent-goal-contract.mjs'];
const verifierBefore = await captureVerifierArtifact(repoRoot, verifierInputs);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(decodeTaskInput(Buffer.concat(chunks)));
const goals = parseGoalContract(JSON.stringify(request.goals));
const session = await openLocalCliSession({overlayRoot:request.overlayRoot,baseRoot:request.baseRoot,
  game:request.game ?? 'sekiro',mode:'plan',principal:'independent-goal-verifier',
  analyze:true,useCache:false,requireDurableLog:false,
  onFallbackWarning:message => process.stderr.write(`${message}\n`)});
try {
  const context = {workspaceIndex:session.workspaceIndex,mode:'plan',modeCeiling:'plan',
    allowMemoryWrite:false,session:session.coreSession.workspaceSession,coreSession:session.coreSession};
  const result = await verifyGoalsThroughNativeTool((tool,input) => session.registry.run(tool,input,context),
    goals,request.treeEvidence,request.taskContract);
  const verifierAfter = await captureVerifierArtifact(repoRoot, verifierInputs);
  const stable = verifierBefore.sha256 === verifierAfter.sha256;
  if (!stable) result.evaluations = result.evaluations.map(goal => ({...goal,verified:false,status:'unverified',reason:'verifier-artifact-changed'}));
  process.stdout.write(`${JSON.stringify({...result,verifier:{...verifierBefore,stable,afterSha256:verifierAfter.sha256,authority:'live-independent-domain-reader',belongsToTestedSnapshot:false}})}\n`);
} finally { await session.dispose(); }
