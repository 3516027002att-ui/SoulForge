import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_CI_CHECKS = Object.freeze([
  { id: 'install', name: 'Locked npm dependencies' },
  { id: 'tools', name: 'Pinned Node/.NET/Electron runtime versions' },
  { id: 'commands', name: 'Generated Bridge command authority' },
  { id: 'typecheck', name: 'Shared/core/desktop typecheck' },
  { id: 'build', name: 'Shared/core/desktop production build' },
  { id: 'csharp', name: 'C# Bridge synthetic regression tests' },
  { id: 'publish', name: 'Matching-host self-contained Bridge publish' },
  { id: 'agent', name: 'Deterministic Agent kernel and host fixtures' },
  { id: 'native', name: 'Native HKS/Lua50/CP932 runtime and synthetic TAE/MAP source fixtures' },
  { id: 'database', name: 'Electron SQLite utility smoke and forced restart' },
  { id: 'theme', name: 'Renderer regressions and sandboxed native theme/frame runtime' },
  { id: 'package', name: 'Unsigned unpacked desktop directory build' },
  { id: 'archive', name: 'Package directory archive' }
]);

export function buildPublicCiReport({ steps = {}, runtime, commit = null, runUrl = null }) {
  if (!['linux-x64', 'win-x64'].includes(runtime)) throw new Error(`Unsupported CI runtime: ${runtime}`);
  const publicChecks = PUBLIC_CI_CHECKS.map(({ id, name }) => {
    const outcome = steps[id]?.outcome ?? 'skipped';
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(outcome)) throw new Error(`Unknown CI outcome for ${id}: ${outcome}`);
    return { id, name, outcome, status: outcome === 'success' ? 'passed' : outcome === 'failure' ? 'failed' : 'not_run' };
  });
  return {
    schemaVersion: 1, runtime, commit, runUrl,
    publicStatus: publicChecks.every(check => check.status === 'passed') ? 'passed'
      : publicChecks.some(check => check.status === 'failed') ? 'failed' : 'not_run',
    acceptanceComplete: false,
    publicChecks,
    unavailableChecks: [
      { name: 'Private game corpus, mature-tool oracle and game rendering acceptance', status: 'unavailable', reason: 'Public runners are not supplied the private game corpus or oracle artifacts.' },
      { name: 'Large KRAK resources and licensed Linux decompression', status: 'unavailable', reason: 'Public runners are not supplied a compatible licensed SDK/tool or the private oversized resources.' },
      { name: 'Real-provider Agent tasks', status: 'unavailable', reason: 'Public CI has no provider credentials or approved provider cost budget.' },
      { name: 'Installer lifecycle and clean-machine runtime acceptance', status: 'unavailable', reason: 'This workflow builds unsigned directories; it does not install or run the packaged app on a clean machine.' }
    ],
    scope: 'Public synthetic/runtime checks and unsigned package directories only. A green public leg does not complete private acceptance or authorize release publishing.'
  };
}

async function main() {
  const report = buildPublicCiReport({ steps: JSON.parse(process.env.CI_STEP_OUTCOMES ?? '{}'),
    runtime: process.env.CI_RUNTIME, commit: process.env.GITHUB_SHA ?? null, runUrl: process.env.CI_RUN_URL ?? null });
  const archive = process.env.CI_PACKAGE_ARCHIVE;
  if (archive && report.publicChecks.find(check => check.id === 'archive').status === 'passed') {
    const metadata = await stat(archive);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('CI package archive is missing or empty');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    report.packageArchive = { path: archive.replaceAll('\\', '/'), bytes: metadata.size, sha256: hash.digest('hex') };
  }
  const output = resolve('output', `ci-public-${report.runtime}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## SoulForge ${report.runtime}`, '', `Public checks: **${report.publicStatus}**`, '',
      ...report.publicChecks.map(check => `- ${check.status}: ${check.name}`), '',
      ...report.unavailableChecks.map(check => `- ${check.status}: ${check.name}. ${check.reason}`), '', report.scope, ''];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
