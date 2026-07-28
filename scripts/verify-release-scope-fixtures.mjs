import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from './subprocess-control.mjs';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'), 'utf8');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'soulforge-release-scope-'));
const cases = [];

try {
  await expectResult('canonical-proposal', source, 0, 'proposal-valid');
  await expectResult('strict-mode-fails-before-ruling', source, 1, 'RELEASE_SCOPE_NOT_FROZEN', false);

  await expectRejected('duplicate-scope-item', (proposal) => {
    proposal.scopeItems.push(structuredClone(proposal.scopeItems[0]));
  }, 'SCOPE_ITEM_ID_DUPLICATE');

  await expectRejected('missing-gate-coverage', (proposal) => {
    proposal.gateCoverage.pop();
  }, 'GATE_COVERAGE_MISSING');

  await expectRejected('unknown-evidence', (proposal) => {
    proposal.scopeItems[0].evidenceRefs = ['EV-NOT-DEFINED'];
  }, 'EVIDENCE_REF_UNKNOWN');

  await expectRejected('private-fixture-masquerade', (proposal) => {
    proposal.corpusPolicy.privateFixtureRegistryIsReleaseCorpus = true;
  }, 'PRIVATE_FIXTURE_RELEASE_AUTHORITY_INVALID');

  await expectRejected('absolute-path-leak', (proposal) => {
    proposal.scopeItems[0].nonClaims.push('C:/Users/example/private/sample.bin');
  }, 'ABSOLUTE_PATH_FORBIDDEN');

  await expectRejected('status-only-fake-approval', (proposal) => {
    proposal.proposalStatus = 'user-approved';
    proposal.gameBuildRange.status = 'user-approved';
    proposal.ruling.status = 'user-approved';
  }, 'RULING_APPROVER_MISSING');

  await expectRejected('gate-pass-masquerade', (proposal) => {
    proposal.gateCoverage[0].currentState = 'passed';
  }, 'GATE_COVERAGE_STATE_INVALID');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  status: 'passed',
  caseCount: cases.length,
  cases
}, null, 2));

async function expectRejected(name, mutate, expectedCode) {
  const proposal = extractProposal(source);
  mutate(proposal);
  await expectResult(name, replaceProposal(source, proposal), 1, expectedCode);
}

async function expectResult(name, document, expectedExit, expectedToken, proposalMode = true) {
  const input = join(temporaryRoot, `${name}.md`);
  await writeFile(input, document, 'utf8');
  const args = ['scripts/verify-release-scope.mjs'];
  if (proposalMode) args.push('--proposal');
  args.push(`--input=${input}`);
  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: root,
    timeoutMs: 10_000
  });
  if (result.timedOut || result.cancelled || result.code !== expectedExit) {
    throw new Error(`${name}: expected exit ${expectedExit}, got ${result.code}; ${result.stderr}`);
  }
  if (!result.stdout.includes(expectedToken)) {
    throw new Error(`${name}: output did not contain ${expectedToken}: ${result.stdout}`);
  }
  cases.push({ name, expectedExit, expectedToken });
}

function extractProposal(document) {
  const match = document.match(
    /<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->/
  );
  if (!match) throw new Error('canonical proposal block missing');
  return JSON.parse(match[1]);
}

function replaceProposal(document, proposal) {
  const serialized = JSON.stringify(proposal, null, 2);
  return document.replace(
    /(<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->\s*```json\s*)[\s\S]*?(\s*```\s*<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->)/,
    `$1${serialized}\n$2`
  );
}
