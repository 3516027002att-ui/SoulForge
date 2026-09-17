import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubReleaseClient, parseLatestYml, parseSha256Sums, sha256Hex, sha512Base64 } from './githubReleaseClient.js';
import { createGitHubFetchTransport } from './httpTransport.js';
import { UpdateStateMachine } from './updateStateMachine.js';
import { GITHUB_UPDATE_REPOSITORY, type UpdateInfo, type UpdateTransport, type UpdateTransportResponse } from './types.js';

const API_URL = `https://api.github.com/repos/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases?per_page=100`;

function asset(name: string, size = 1): Record<string, unknown> {
  return { name, size, state: 'uploaded', browser_download_url: `https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases/download/v0.9.2/${name}` };
}

function packageBytes(): Uint8Array {
  return new TextEncoder().encode('signed-by-github-release-fixture');
}

function latestYml(version: string, installer: string, bytes: Uint8Array): string {
  return `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512Base64(bytes)}\n    size: ${bytes.byteLength}\npath: ${installer}\nsha512: ${sha512Base64(bytes)}\n`;
}

function releaseAt(version = '0.9.2', prerelease = false, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bytes = packageBytes();
  const installer = `SoulForge-${version}-x64.exe`;
  const tag = `v${version}`;
  return {
    tag_name: tag,
    name: `SoulForge ${version}`,
    body: '更新说明',
    draft: false,
    prerelease,
    published_at: '2026-09-16T00:00:00Z',
    html_url: `https://github.com/3516027002att-ui/SoulForge/releases/tag/${tag}`,
    assets: [
      { ...asset(installer, bytes.byteLength), browser_download_url: `https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases/download/${tag}/${installer}` },
      { ...asset(`${installer}.blockmap`, 10), browser_download_url: `https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases/download/${tag}/${installer}.blockmap` },
      { ...asset('latest.yml', latestYml(version, installer, bytes).length), browser_download_url: `https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases/download/${tag}/latest.yml` },
      { ...asset('SHA256SUMS.txt', 80), browser_download_url: `https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases/download/${tag}/SHA256SUMS.txt` }
    ],
    ...overrides
  };
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return releaseAt('0.9.2', false, overrides);
}

class FixtureTransport implements UpdateTransport {
  public readonly calls: string[] = [];
  public readonly responses = new Map<string, Uint8Array>();
  public releases: unknown[] = [release()];

  public async get(url: string): Promise<UpdateTransportResponse> {
    this.calls.push(url);
    if (url === API_URL) return { status: 200, url, body: new TextEncoder().encode(JSON.stringify(this.releases)) };
    const body = this.responses.get(url);
    if (!body) throw new Error(`fixture missing: ${url}`);
    return { status: 200, url, body };
  }
}

function seedRelease(transport: FixtureTransport, current = '0.9.1'): void {
  const bytes = packageBytes();
  const installer = 'SoulForge-0.9.2-x64.exe';
  transport.responses.set(`https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2/latest.yml`, new TextEncoder().encode(latestYml('0.9.2', installer, bytes)));
  transport.responses.set(`https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2/SHA256SUMS.txt`, new TextEncoder().encode(`${sha256Hex(bytes)}  ${installer}\n`));
  void current;
}

test('GitHub client selects a newer Windows x64 NSIS release and redacts no local data', async () => {
  const transport = new FixtureTransport();
  seedRelease(transport);
  const result = await new GitHubReleaseClient({ currentVersion: '0.9.1', transport }).check();
  assert.equal(result.kind, 'available');
  if (result.kind !== 'available') return;
  assert.deepEqual(result.update.info, {
    version: '0.9.2',
    tag: 'v0.9.2',
    channel: 'stable',
    releaseName: 'SoulForge 0.9.2',
    releaseNotes: '更新说明',
    publishedAt: '2026-09-16T00:00:00Z',
    releaseUrl: 'https://github.com/3516027002att-ui/SoulForge/releases/tag/v0.9.2',
    installerName: 'SoulForge-0.9.2-x64.exe',
    installerSize: packageBytes().byteLength,
    installerSha256: sha256Hex(packageBytes())
  });
  assert.equal('installerUrl' in result.update.info, false);
  assert.equal(transport.calls[0], API_URL);
});

test('prereleases are included, drafts and downgrades are excluded', async () => {
  const transport = new FixtureTransport();
  transport.releases = [
    releaseAt('9.0.0', false, { draft: true }),
    releaseAt('0.8.0'),
    releaseAt('0.9.2-beta.1', true),
    releaseAt('0.9.1')
  ];
  // The selected prerelease uses a different installer/asset URLs; provide its metadata too.
  const bytes = packageBytes();
  const installer = 'SoulForge-0.9.2-beta.1-x64.exe';
  const base = 'https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2-beta.1/latest.yml';
  transport.responses.set(base, new TextEncoder().encode(latestYml('0.9.2-beta.1', installer, bytes)));
  transport.responses.set('https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2-beta.1/SHA256SUMS.txt', new TextEncoder().encode(`${sha256Hex(bytes)}  ${installer}\n`));
  const result = await new GitHubReleaseClient({ currentVersion: '0.9.1', transport }).check();
  assert.equal(result.kind, 'available');
  if (result.kind === 'available') assert.equal(result.update.info.channel, 'prerelease');
});

test('no update is reported when every non-draft release is not newer', async () => {
  const transport = new FixtureTransport();
  transport.releases = [release({ tag_name: 'v0.9.1' }), release({ tag_name: 'v0.9.0' })];
  const result = await new GitHubReleaseClient({ currentVersion: '0.9.1', transport }).check();
  assert.deepEqual(result, { kind: 'not-available' });
});

test('non-Windows or non-x64 callers are rejected before contacting GitHub', async () => {
  const transport = new FixtureTransport();
  await assert.rejects(
    () => new GitHubReleaseClient({ currentVersion: '0.9.1', transport, platform: 'linux', arch: 'x64' }).check(),
    /Windows x64/
  );
  assert.equal(transport.calls.length, 0);
});

test('missing assets, malformed latest.yml, and malformed SHA256SUMS fail closed', async () => {
  const transport = new FixtureTransport();
  const candidate = release();
  candidate.assets = [asset('SoulForge-0.9.2-x64.exe')];
  transport.releases = [candidate];
  await assert.rejects(() => new GitHubReleaseClient({ currentVersion: '0.9.1', transport }).check(), /资产/);

  const malformedLatest = new FixtureTransport();
  seedRelease(malformedLatest);
  malformedLatest.responses.set('https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2/latest.yml', new TextEncoder().encode('version: 0.9.2\npath: wrong.exe\n'));
  await assert.rejects(() => new GitHubReleaseClient({ currentVersion: '0.9.1', transport: malformedLatest }).check(), /latest/);

  const malformedSums = new FixtureTransport();
  seedRelease(malformedSums);
  malformedSums.responses.set('https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2/SHA256SUMS.txt', new TextEncoder().encode(`not-a-checksum\n`));
  await assert.rejects(() => new GitHubReleaseClient({ currentVersion: '0.9.1', transport: malformedSums }).check(), /SHA256/);

  const unsafeAsset = new FixtureTransport();
  const unsafeRelease = release();
  unsafeRelease.assets = [{ ...asset('SoulForge-0.9.2-x64.exe'), browser_download_url: 'https://evil.example/update.exe' }];
  unsafeAsset.releases = [unsafeRelease];
  await assert.rejects(() => new GitHubReleaseClient({ currentVersion: '0.9.1', transport: unsafeAsset }).check(), /受信任/);

  const wrongRepository = new FixtureTransport();
  const wrongRepositoryRelease = release();
  wrongRepositoryRelease.assets = [
    ...(release().assets as unknown[]),
    { ...asset('unrelated.exe'), browser_download_url: 'https://github.com/another-owner/another-repo/releases/download/v0.9.2/unrelated.exe' }
  ];
  wrongRepository.releases = [wrongRepositoryRelease];
  await assert.rejects(() => new GitHubReleaseClient({ currentVersion: '0.9.1', transport: wrongRepository }).check(), /受信任|固定/);
});

test('SHA256SUMS parser and latest.yml parser accept standard files and reject bad records', () => {
  const bytes = packageBytes();
  const hash = sha256Hex(bytes);
  const installer = 'SoulForge-0.9.2-x64.exe';
  assert.equal(parseSha256Sums(`${hash} *${installer}\n`).get(installer), hash);
  assert.equal(parseLatestYml(latestYml('0.9.2', installer, bytes), installer).version, '0.9.2');
  assert.equal(parseLatestYml(latestYml('0.9.2', installer, bytes), installer).size, bytes.byteLength);
  assert.throws(() => parseSha256Sums('bad'), /SHA256/);
  assert.throws(() => parseLatestYml('version: 0.9.2\npath: other.exe\n', installer), /latest/);
  assert.throws(() => parseLatestYml(`version: 0.9.2\nfiles:\n  - url: ${installer}\n    sha512: ${sha512Base64(bytes)}\npath: ${installer}\nsha512: ${sha512Base64(bytes)}\n`, installer), /大小/);
  assert.throws(() => parseLatestYml(`version: 0.9.2\nfiles:\n  - url: ${installer}\n    sha512: ${sha512Base64(bytes)}\n    size: ${bytes.byteLength}\npath: ${installer}\nsha512: ${'A'.repeat(88)}\n`, installer), /latest/);
});

test('fetch transport enforces HTTPS GitHub redirects, timeout, and response size', async () => {
  const response = (url: string, status: number, body = 'ok', headers: Record<string, string> = {}) => new Response(body, { status, headers: { ...headers, ...(status >= 300 && status < 400 ? { location: url } : {}) } });
  const redirectTransport = createGitHubFetchTransport({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com/update.exe' } }) });
  await assert.rejects(() => redirectTransport.get('https://api.github.com/test'), /重定向/);
  const oversized = createGitHubFetchTransport({ maxBytes: 2, fetchImpl: async () => response('https://api.github.com/test', 200, 'toolong') });
  await assert.rejects(() => oversized.get('https://api.github.com/test'), /大小上限/);
  const timedOut = createGitHubFetchTransport({ timeoutMs: 1, fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('UPDATE_TIMEOUT')), { once: true });
  }) });
  await assert.rejects(() => timedOut.get('https://api.github.com/test'), /超时/);
  await assert.rejects(() => redirectTransport.get('http://api.github.com/test'), /受信任/);
});

interface FixtureDownloader {
  calls: number;
  resolve: ((value: { token: string; installerBytes: Uint8Array }) => void) | null;
  download(input: { onProgress: (value: { downloadedBytes: number; totalBytes: number }) => void }): Promise<{ token: string; installerBytes: Uint8Array }>;
}

function machineFixture(): { machine: UpdateStateMachine; transport: FixtureTransport; downloader: FixtureDownloader } {
  const transport = new FixtureTransport();
  seedRelease(transport);
  const downloader = {
    calls: 0,
    resolve: null as ((value: { token: string; installerBytes: Uint8Array }) => void) | null,
    async download(input: { onProgress: (value: { downloadedBytes: number; totalBytes: number }) => void }): Promise<{ token: string; installerBytes: Uint8Array }> {
      this.calls += 1;
      input.onProgress({ downloadedBytes: 1, totalBytes: packageBytes().byteLength });
      return new Promise((resolve) => { this.resolve = resolve; });
    }
  };
  const machine = new UpdateStateMachine(
    new GitHubReleaseClient({ currentVersion: '0.9.1', transport }),
    downloader,
    { async install() {} }
  );
  return { machine, transport, downloader };
}

test('state machine coalesces concurrent checks and rejects concurrent downloads', async () => {
  const fixture = machineFixture();
  const first = fixture.machine.check();
  const second = fixture.machine.check();
  assert.equal(first, second);
  assert.equal((await first).status, 'available');
  const download = fixture.machine.download();
  const concurrent = await fixture.machine.download();
  assert.equal(concurrent.status, 'error');
  assert.equal(fixture.machine.state.status, 'downloading');
  assert.equal(fixture.downloader.calls, 1);
  fixture.downloader.resolve?.({ token: 'opaque-install-token', installerBytes: packageBytes() });
  assert.equal((await download).status, 'pending-install');
});

test('download verifies SHA-256/SHA-512 before pending-install and cancel aborts without installing', async () => {
  const fixture = machineFixture();
  await fixture.machine.check();
  const download = fixture.machine.download();
  const wrongBytes = packageBytes();
  wrongBytes[0] = (wrongBytes[0] ?? 0) ^ 1;
  fixture.downloader.resolve?.({ token: 'opaque', installerBytes: wrongBytes });
  const failed = await download;
  assert.equal(failed.status, 'error');
  if (failed.status === 'error') assert.equal(failed.diagnostic.code, 'UPDATE_HASH_MISMATCH');

  await fixture.machine.check();
  const secondDownload = fixture.machine.download();
  const cancelled = fixture.machine.cancel();
  assert.equal(cancelled.status, 'cancelled');
  fixture.downloader.resolve?.({ token: 'late', installerBytes: packageBytes() });
  assert.equal((await secondDownload).status, 'cancelled');
});

test('a cancelled check cannot clear a newer check promise', async () => {
  let releaseCheckCount = 0;
  let releaseFirstCheck = (): void => {};
  const transport: UpdateTransport = {
    async get(url: string): Promise<UpdateTransportResponse> {
      if (url !== API_URL) throw new Error(`unexpected fixture URL: ${url}`);
      releaseCheckCount += 1;
      if (releaseCheckCount === 1) {
        await new Promise<void>((resolve) => { releaseFirstCheck = resolve; });
      }
      return { status: 200, url, body: new TextEncoder().encode(JSON.stringify([])) };
    }
  };
  const machine = new UpdateStateMachine(
    new GitHubReleaseClient({ currentVersion: '0.9.1', transport }),
    { async download() { throw new Error('not used'); } },
    { async install() {} }
  );
  const first = machine.check();
  assert.equal(machine.cancel().status, 'cancelled');
  const second = machine.check();
  releaseFirstCheck();
  assert.equal((await second).status, 'up-to-date');
  assert.equal(releaseCheckCount, 2);
  await first;
});

test('pending install passes only an opaque token to the injected installer', async () => {
  const fixture = machineFixture();
  let received: { update: unknown; token: string } | null = null;
  const installer = {
    async install(input: { update: unknown; token: string }): Promise<void> { received = input; }
  };
  const machine = new UpdateStateMachine(
    new GitHubReleaseClient({ currentVersion: '0.9.1', transport: fixture.transport }),
    fixture.downloader,
    installer
  );
  await machine.check();
  const download = machine.download();
  fixture.downloader.resolve?.({ token: 'opaque-install-token', installerBytes: packageBytes() });
  assert.equal((await download).status, 'pending-install');
  assert.equal((await machine.install()).status, 'installed');
  const installerInput = received!;
  assert.equal(installerInput.token, 'opaque-install-token');
  assert.equal((installerInput.update as UpdateInfo).installerName, 'SoulForge-0.9.2-x64.exe');
});

test('concurrent install clicks share one installation promise', async () => {
  const fixture = machineFixture();
  let installCalls = 0;
  let finishInstall = (): void => {};
  const machine = new UpdateStateMachine(
    new GitHubReleaseClient({ currentVersion: '0.9.1', transport: fixture.transport }),
    fixture.downloader,
    {
      async install(): Promise<void> {
        installCalls += 1;
        await new Promise<void>((resolve) => { finishInstall = resolve; });
      }
    }
  );
  await machine.check();
  const download = machine.download();
  fixture.downloader.resolve?.({ token: 'opaque-install-token', installerBytes: packageBytes() });
  await download;
  const first = machine.install();
  const second = machine.install();
  assert.equal(first, second);
  assert.equal(installCalls, 1);
  finishInstall();
  assert.equal((await first).status, 'installed');
});
