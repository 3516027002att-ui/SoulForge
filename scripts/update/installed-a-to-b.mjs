/** Actual, unsigned, isolated NSIS A/B lifecycle. Never an automatic-update claim.
 * Execution requires a main/operator-approved manifest with artifact hashes and
 * a separate validation identity. No existing install/profile/process is reused. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, lstat, realpath, rm, rmdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import semver from 'semver';
import { runProcess, processSucceeded } from '../subprocess-control.mjs';

const entrypoint = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const nonClaims = ['Application-initiated automatic update/feed/download/quitAndInstall', 'Upgrade of the official SoulForge installation',
  'Different-source version regression; A/B use the same source with distinct package metadata', 'Signing, SmartScreen/UAC and cross-machine acceptance'];
const inside = (root, path) => { const value = relative(resolve(root), resolve(path)); return value !== '' && value !== '..' && !value.startsWith(`..\\`) && !value.startsWith('../') && !isAbsolute(value); };
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

export async function validateInstalledManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.execute !== true || manifest.scope !== 'unsigned-owned-identity-manual-nsis-a-to-b-same-source') {
    throw fail('UPDATE_INSTALLED_APPROVAL_REQUIRED', 'An explicit approved actual A/B manifest is required.');
  }
  const identity = manifest.identity;
  if (!identity || !/^com\.soulforge\.validation\.[a-f0-9]{12,64}$/i.test(identity.appId ?? '')
    || !/^SoulForge Validation [a-f0-9]{6,32}$/i.test(identity.productName ?? '')
    || identity.shortcutName !== identity.productName
    || !/^SoulForgeValidation-[a-f0-9]{6,32}$/i.test(identity.executableName ?? '')
    || !/^soulforge-validation-[a-f0-9]{6,32}$/i.test(identity.packageName ?? '')) {
    throw fail('UPDATE_INSTALLED_IDENTITY_UNSAFE', 'Only a separate owned validation identity is accepted; official SoulForge identities are forbidden.');
  }
  const suffix = identity.productName.split(' ').at(-1).toLowerCase();
  if (identity.executableName.toLowerCase() !== `soulforgevalidation-${suffix}` || identity.packageName.toLowerCase() !== `soulforge-validation-${suffix}`) {
    throw fail('UPDATE_INSTALLED_IDENTITY_UNSAFE', 'Owned executable/package/shortcut identities must agree.');
  }
  if (!semver.valid(manifest.a?.version) || !semver.valid(manifest.b?.version) || !semver.gt(manifest.b.version, manifest.a.version)) {
    throw fail('UPDATE_INSTALLED_VERSION_INVALID', 'Actual A/B versions must be distinct and B must be newer.');
  }
  if (manifest.asarModulePath !== undefined || manifest.asarModuleSha256 !== undefined) {
    if (!isAbsolute(manifest.asarModulePath ?? '') || !/^[a-f0-9]{64}$/.test(manifest.asarModuleSha256 ?? '')) {
      throw fail('UPDATE_INSTALLED_TOOL_INVALID', 'An explicit ASAR module needs an approved absolute path and SHA-256.');
    }
    const stat = await lstat(manifest.asarModulePath);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(await readFile(manifest.asarModulePath)) !== manifest.asarModuleSha256) {
      throw fail('UPDATE_INSTALLED_TOOL_INVALID', 'The explicit ASAR module does not match its approved hash.');
    }
  }
  for (const [label, artifact] of [['A', manifest.a], ['B', manifest.b]]) {
    if (!isAbsolute(artifact.path ?? '') || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw fail('UPDATE_INSTALLED_ARTIFACT_INVALID', `Actual ${label} path/hash is required.`);
    const stat = await lstat(artifact.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('UPDATE_INSTALLED_ARTIFACT_INVALID', `Actual ${label} must be a regular installer file.`);
    const bytes = await readFile(artifact.path);
    if (bytes.length < 64 || bytes.subarray(0, 2).toString() !== 'MZ' || sha256(bytes) !== artifact.sha256) {
      throw fail('UPDATE_INSTALLED_ARTIFACT_INVALID', `Actual ${label} PE/hash does not match the approved artifact.`);
    }
  }
  if (manifest.a.sha256 === manifest.b.sha256 || await realpath(manifest.a.path) === await realpath(manifest.b.path)) {
    throw fail('UPDATE_INSTALLED_ARTIFACT_INVALID', 'The same installer cannot establish actual A/B upgrade.');
  }
  try {
    const readBoundJson = async (path, hash) => {
      assert.ok(isAbsolute(path ?? '') && /^[a-f0-9]{64}$/.test(hash ?? ''), 'absolute receipt/config path and SHA-256 are required');
      const stat = await lstat(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'receipt/config must be a regular file');
      const bytes = await readFile(path);
      assert.equal(sha256(bytes), hash, 'actual receipt/config bytes must match the approved hash');
      return JSON.parse(bytes.toString('utf8'));
    };
    const receipt = await readBoundJson(manifest.buildReceiptPath, manifest.buildReceiptSha256);
    assert.equal(receipt.schemaVersion, 1); assert.ok(semver.valid(receipt.builderVersion));
    assert.match(receipt.sourceHead, /^[a-f0-9]{40}$/i); assert.deepEqual(receipt.identity, identity);
    for (const label of ['a', 'b']) {
      assert.deepEqual(receipt[label], manifest[label], 'receipt must bind the exact approved installer/version/hash');
      const config = await readBoundJson(receipt.configs?.[label]?.path, receipt.configs?.[label]?.sha256);
      assert.equal(config.appId, identity.appId); assert.equal(config.productName, identity.productName);
      assert.equal(config.executableName ?? config.win?.executableName, identity.executableName);
      assert.equal(config.nsis?.shortcutName, identity.shortcutName);
      assert.equal(config.nsis?.uninstallDisplayName, identity.productName);
      assert.equal(config.extraMetadata?.name, identity.packageName);
      assert.equal(config.extraMetadata?.productName, identity.productName);
      assert.equal(config.extraMetadata?.version, manifest[label].version);
    }
  } catch (error) { throw fail('UPDATE_INSTALLED_BUILD_RECEIPT_INVALID', error.message); }
  return manifest;
}

// The product followed by a valid package version is also an NSIS DisplayName.
// A broad "SoulForge" prefix would include the isolated validation identity.
export function registryDisplayMatches(displayName, productName) {
  return typeof displayName === 'string' && (displayName === productName
    || (displayName.startsWith(`${productName} `) && semver.valid(displayName.slice(productName.length + 1)) !== null));
}

async function readPowerShellJson(script, input) {
  const prelude = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; ";
  const result = await runProcess({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prelude + script, 'utf16le').toString('base64')],
    stdinData: JSON.stringify(input), timeoutMs: 15000 });
  if (!processSucceeded(result) || result.stdoutTruncated || result.stderrTruncated) throw fail('UPDATE_INSTALLED_PREFLIGHT_FAILED', 'Read-only Windows metadata query did not complete safely.');
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

export async function readInstallerVersionInfo(paths) {
  return readPowerShellJson("$rows=@(foreach($path in $request.paths){ $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($path); [pscustomobject]@{path=$path;productName=$info.ProductName;fileDescription=$info.FileDescription;productVersion=$info.ProductVersion} }); ConvertTo-Json -InputObject $rows -Compress -Depth 4", { paths });
}

export function assertInstallerProductNames(manifest, rows) {
  if (!Array.isArray(rows) || rows.length !== 2) throw fail('UPDATE_INSTALLED_BINARY_IDENTITY_UNSAFE', 'Both actual installer PE identities are required before execution.');
  for (const [index, label] of ['a', 'b'].entries()) {
    if (resolve(rows[index]?.path ?? '').toLowerCase() !== resolve(manifest[label].path).toLowerCase()
      || rows[index]?.productName !== manifest.identity.productName) {
      throw fail('UPDATE_INSTALLED_BINARY_IDENTITY_UNSAFE', `Actual ${label.toUpperCase()} PE ProductName is not the approved owned identity.`);
    }
  }
}

export async function registrySnapshot(productName) {
  const rows = await readPowerShellJson(`$roots=@(
    @{base=[Microsoft.Win32.Registry]::CurrentUser;path='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'},
    @{base=[Microsoft.Win32.Registry]::LocalMachine;path='SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'},
    @{base=[Microsoft.Win32.Registry]::LocalMachine;path='SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'});
    $rows=@(foreach($root in $roots){$hive=$root.base.OpenSubKey($root.path,$false); if($null -eq $hive){continue}; try {
      foreach($name in ($hive.GetSubKeyNames() | Sort-Object)){$key=$hive.OpenSubKey($name,$false); if($null -eq $key){throw 'Uninstall key changed during read'}; try {
        $display=[string]$key.GetValue('DisplayName'); if($display -eq $request.productName -or $display.StartsWith($request.productName+' ')){
          $values=[ordered]@{}; foreach($valueName in ($key.GetValueNames() | Sort-Object)){$values[$valueName]=$key.GetValue($valueName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)};
          [pscustomobject]@{key=$key.Name;displayName=$display;values=$values}
        }
      }finally{$key.Dispose()}}
    }finally{$hive.Dispose()}}); ConvertTo-Json -InputObject $rows -Compress -Depth 8`, { productName });
  if (!Array.isArray(rows)) throw fail('UPDATE_INSTALLED_PREFLIGHT_FAILED', 'Registry snapshot shape is invalid.');
  return rows.filter(row => registryDisplayMatches(row.displayName, productName)).sort((a, b) => a.key.localeCompare(b.key));
}
function registryKeys(snapshot) { return snapshot.map(entry => entry.key); }

export async function removeOwnedEmptyScratch(scratch, parent) {
  assert.ok(inside(parent, scratch), 'scratch must stay inside its trusted parent');
  assert.equal((await realpath(parent)).toLowerCase(), resolve(parent).toLowerCase(), 'trusted parent must remain unchanged');
  const stat = await lstat(scratch);
  assert.equal(stat.isSymbolicLink(), false, 'owned scratch must not be linked');
  assert.equal((await realpath(scratch)).toLowerCase(), resolve(scratch).toLowerCase(), 'owned scratch must remain unchanged');
  assert.equal((await readdir(scratch)).length, 0, 'only an empty owned scratch may be removed');
  await rmdir(scratch);
}
async function knownFolder(name) {
  const result = await runProcess({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::GetFolderPath('${name}')`], timeoutMs: 15000 });
  if (!processSucceeded(result) || !result.stdout.trim()) throw fail('UPDATE_INSTALLED_PREFLIGHT_FAILED', `Cannot resolve ${name} folder.`);
  return result.stdout.trim();
}
async function waitUntil(check, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  do { if (await check()) return; await new Promise(done => setTimeout(done, 250)); } while (Date.now() < deadline);
  throw fail('UPDATE_INSTALLED_CLEAN_TIMEOUT', 'Owned installer state did not settle within its timeout.');
}

export async function closeOwnedElectronApplication(application, child) {
  assert.ok(child?.pid, 'capture the owned child before closing its Playwright dispatcher');
  await application.close();
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 15000);
}

async function assertUnlinkedDirectory(path) {
  const stat = await lstat(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'owned profile leaf/parent must be an unlinked directory');
  if (process.platform === 'win32') {
    const isReparsePoint = await readPowerShellJson("([IO.File]::GetAttributes($request.path) -band [IO.FileAttributes]::ReparsePoint) -ne 0 | ConvertTo-Json -Compress", { path });
    assert.equal(isReparsePoint, false, 'owned profile leaf/parent must not be a reparse point');
  }
}

export async function resolveOwnedProfile(appDataRoot, productName, runtimeUserData,
  files = { realpath, assertUnlinkedDirectory }) {
  const logical = join(appDataRoot, productName);
  assert.equal(resolve(runtimeUserData).toLowerCase(), resolve(logical).toLowerCase(), 'actual profile must match its owned identity');
  await files.assertUnlinkedDirectory(logical);
  const physical = await files.realpath(logical), parent = dirname(physical);
  assert.equal((await files.realpath(runtimeUserData)).toLowerCase(), physical.toLowerCase(), 'actual profile must resolve to the observed owned leaf');
  assert.equal(basename(physical).toLowerCase(), productName.toLowerCase());
  await files.assertUnlinkedDirectory(parent);
  assert.equal((await files.realpath(parent)).toLowerCase(), parent.toLowerCase());
  return { root: appDataRoot, rootPhysical: await files.realpath(appDataRoot), logical, physical, parent };
}

export async function removeOwnedProfile(profile) {
  assert.equal((await realpath(profile.root)).toLowerCase(), profile.rootPhysical.toLowerCase(), 'owned AppData root must remain unchanged');
  await assertUnlinkedDirectory(profile.logical);
  await assertUnlinkedDirectory(profile.parent);
  assert.equal((await realpath(profile.logical)).toLowerCase(), profile.physical.toLowerCase(), 'owned physical leaf must remain unchanged');
  assert.equal((await realpath(profile.parent)).toLowerCase(), profile.parent.toLowerCase(), 'owned physical parent must remain unchanged');
  assert.ok(inside(profile.parent, profile.physical));
  await rm(profile.physical, { recursive: true, force: true });
}

export async function runInstalledProbe(input) {
  const { repositoryRoot, evidenceRoot, runId, headSha, installedConfigPath } = input;
  await mkdir(evidenceRoot, { recursive: true });
  const binding = { runId, headSha, entrypointSha256: sha256(await readFile(entrypoint)) };
  const blocked = message => ({ ...binding, status: 'blocked_environment', commands: [], artifacts: [], blockers: [message], untestedClaims: nonClaims,
    cases: [{ id: 'installer-a-to-b', status: 'blocked', executed: false, evidenceLevel: 'installed-e2e', assertions: [], evidenceFiles: [], diagnostics: [message] }] });
  if (process.platform !== 'win32') return blocked('UPDATE_INSTALLED_PLATFORM_REQUIRED: Actual A/B NSIS execution requires Windows.');
  if (!installedConfigPath) return blocked('UPDATE_INSTALLED_ARTIFACTS_REQUIRED: Approved actual A/B installer manifest is missing.');
  let manifest;
  try { manifest = await validateInstalledManifest(JSON.parse(await readFile(installedConfigPath, 'utf8'))); }
  catch (error) { return blocked(error.message); }
  const commands = [], artifacts = [], receipts = [];
  let scratch, scratchParent, installedOwned = false, userData, ownedProfile, appDataRoot, shortcutPaths = [], baseline;
  const evidence = async (name, value) => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value, null, 2));
    await writeFile(join(evidenceRoot, name), bytes);
    artifacts.push({ relativePath: name, bytes: bytes.length, sha256: sha256(bytes) });
  };
  const execute = async (label, command, args, timeoutMs) => {
    const result = await runProcess({ command, args, cwd: repositoryRoot, timeoutMs });
    await evidence(`${label}.stdout.txt`, result.stdout); await evidence(`${label}.stderr.txt`, result.stderr);
    commands.push({ argv: [command, ...args], exitCode: result.code, status: processSucceeded(result) ? 'executed' : result.timedOut ? 'timeout' : 'failed',
      timedOut: result.timedOut, cancelled: result.cancelled, stdoutArtifact: `${label}.stdout.txt`, stderrArtifact: `${label}.stderr.txt` });
    if (!processSucceeded(result)) throw fail('UPDATE_INSTALLED_PROCESS_FAILED', `${label} exit=${result.code}, timeout=${result.timedOut}`);
  };
  let failure, completedReport;
  try {
    const { identity } = manifest;
    let extractFile, _electron;
    try {
      const asar = createRequire(import.meta.url)(manifest.asarModulePath ?? '@electron/asar');
      assert.equal(typeof asar.extractFile, 'function'); extractFile = asar.extractFile;
      ({ _electron } = await import('playwright'));
    } catch (error) { return blocked(`UPDATE_INSTALLED_TOOL_REQUIRED: Official ASAR/Playwright tools unavailable: ${error.message}`); }
    // Operator declarations and MZ/hash checks alone cannot establish isolation.
    // Reject a formal installer before it can write formal registry/install state.
    const installerIdentities = await readInstallerVersionInfo([manifest.a.path, manifest.b.path]);
    assertInstallerProductNames(manifest, installerIdentities);
    await evidence('installer-preflight.json', { installerIdentities, buildReceiptPath: manifest.buildReceiptPath,
      buildReceiptSha256: manifest.buildReceiptSha256 });
    appDataRoot = await knownFolder('ApplicationData');
    userData = join(appDataRoot, identity.productName);
    shortcutPaths = [join(await knownFolder('Desktop'), `${identity.shortcutName}.lnk`), join(await knownFolder('Programs'), `${identity.shortcutName}.lnk`)];
    const preOwned = await registrySnapshot(identity.productName);
    if (registryKeys(preOwned).length || await exists(userData) || (await Promise.all(shortcutPaths.map(exists))).some(Boolean)) {
      return blocked('UPDATE_INSTALLED_EXISTING_OWNED_STATE: Owned registry/profile/shortcut already exists; it is preserved.');
    }
    baseline = await registrySnapshot('SoulForge');
    scratchParent = await realpath(tmpdir());
    scratch = await mkdtemp(join(scratchParent, 'soulforge-update-installed-'));
    if ((await lstat(scratch)).isSymbolicLink()) throw fail('UPDATE_INSTALLED_TARGET_UNSAFE', 'Owned scratch cannot be linked.');
    scratch = await realpath(scratch);
    if (scratch.includes(' ')) return blocked('UPDATE_INSTALLED_TARGET_UNSAFE: NSIS /D requires a space-free owned temporary target.');
    const target = join(scratch, 'install');
    assert.ok(inside(scratch, target));
    const launchReceipt = async (label, artifact) => {
      const asarPath = join(target, 'resources/app.asar');
      assert.ok(inside(scratch, await realpath(asarPath)), 'installed ASAR must stay in the owned target');
      const metadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
      // Check package identity before starting any application-owned storage.
      assert.equal(metadata.name, identity.packageName); assert.equal(metadata.productName, identity.productName); assert.equal(metadata.version, artifact.version);
      installedOwned = true;
      const executable = join(target, `${identity.executableName}.exe`);
      assert.ok(inside(scratch, await realpath(executable)), 'installed executable must stay in the owned target');
      const application = await _electron.launch({ executablePath: executable, timeout: 60000 });
      const child = application.process();
      let stdout = '', stderr = '', launchFailure;
      child.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-32768); });
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32768); });
      try {
        const receipt = await application.evaluate(({ app, BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.hide();
          return { version: app.getVersion(), name: app.getName(), userData: app.getPath('userData'), appPath: app.getAppPath(), executable: process.execPath,
            isPackaged: app.isPackaged, pid: process.pid };
        });
        assert.equal(receipt.version, artifact.version); assert.equal(receipt.name, identity.productName); assert.equal(receipt.isPackaged, true);
        assert.equal(resolve(receipt.executable).toLowerCase(), resolve(executable).toLowerCase());
        const observedProfile = await resolveOwnedProfile(appDataRoot, identity.productName, receipt.userData);
        if (ownedProfile) assert.deepEqual(observedProfile, ownedProfile, 'B must use the same owned physical profile as A');
        ownedProfile = observedProfile;
        assert.equal(resolve(receipt.appPath).toLowerCase(), resolve(asarPath).toLowerCase());
        const window = await application.firstWindow({ timeout: 60000 });
        await window.waitForFunction(() => typeof window.soulforge === 'object', undefined, { timeout: 60000 });
        receipt.asarSha256 = sha256(await readFile(asarPath)); receipt.executableSha256 = sha256(await readFile(executable));
        receipts.push({ label, ...receipt });
        await evidence(`${label}.launch.json`, receipt);
        commands.push({ argv: [executable, '(Playwright-owned real application launch)'], exitCode: 0, status: 'executed' });
      } catch (error) { launchFailure = error; throw error; }
      finally {
        try { await closeOwnedElectronApplication(application, child); }
        catch (error) {
          await evidence(`${label}.close-failure.json`, { message: error.message, stack: error.stack, pid: child.pid });
          if (!launchFailure) throw error; // preserve the original startup/assertion failure
        } finally {
          await evidence(`${label}.application.stdout.txt`, stdout);
          await evidence(`${label}.application.stderr.txt`, stderr);
        }
      }
    };
    await execute('install-a', manifest.a.path, ['/S', '/currentuser', `/D=${target}`], 300000);
    await launchReceipt('a', manifest.a);
    assert.ok(registryKeys(await registrySnapshot(identity.productName)).length, 'actual A must register its owned installer');
    await execute('install-b', manifest.b.path, ['/S', '/currentuser', `/D=${target}`], 300000);
    await launchReceipt('b', manifest.b);
    assert.notEqual(receipts[0].asarSha256, receipts[1].asarSha256, 'distinct actual package metadata must be installed');
    const uninstallers = (await readdir(target)).filter(name => /^Uninstall.*\.exe$/i.test(name));
    assert.equal(uninstallers.length, 1);
    await execute('uninstall', join(target, uninstallers[0]), ['/S', '/currentuser'], 180000);
    await waitUntil(async () => !(await exists(target)) && registryKeys(await registrySnapshot(identity.productName)).length === 0
      && !(await Promise.all(shortcutPaths.map(exists))).some(Boolean));
    installedOwned = false;
    assert.deepEqual(await registrySnapshot('SoulForge'), baseline, 'official installation registry must remain unchanged');
    if (await exists(userData)) {
      assert.ok(ownedProfile, 'only an actually observed owned profile can be cleaned');
      await removeOwnedProfile(ownedProfile);
    }
    assert.equal(await exists(userData), false, 'only the fresh owned profile must be cleaned');
    await evidence('receipt.json', { runId, headSha, scope: manifest.scope, identity, a: manifest.a, b: manifest.b, receipts,
      installerIdentities, buildReceiptSha256: manifest.buildReceiptSha256, officialRegistryBefore: baseline, officialRegistryAfter: await registrySnapshot('SoulForge'),
      ownedProfile,
      manualNsisUpgrade: true, automaticUpdateExecuted: false, cleanupVerified: true, officialRegistryUnchanged: true });
    completedReport = { ...binding, status: 'passed', commands, artifacts, blockers: [], untestedClaims: nonClaims,
      cases: [{ id: 'installer-a-to-b', status: 'passed', executed: true, evidenceLevel: 'installed-e2e',
        assertions: ['actual approved NSIS A installed and launched', 'actual approved newer B replaced A and launched from the same owned target',
          'real main-process version/profile/package receipts', 'owned uninstall/registry/shortcuts/target cleaned; official registry unchanged'],
        evidenceFiles: ['a.launch.json', 'b.launch.json', 'receipt.json'] }] };
  } catch (error) {
    failure = error;
    await evidence('failure.json', { message: error.message, stack: error.stack, ownedRecoveryTarget: scratch ?? null });
  }
  finally {
    // Never erase a failed installation in place of uninstalling it. Preserve
    // failed targets for recovery; remove only empty, successfully cleaned roots.
    if (scratch && !installedOwned && !(await exists(join(scratch, 'install')))) {
      try { await removeOwnedEmptyScratch(scratch, scratchParent); }
      catch (error) { failure ??= error; }
    }
  }
  if (completedReport && !failure) return completedReport;
  return { ...binding, status: 'failed', commands, artifacts, blockers: [failure.message], untestedClaims: nonClaims,
    cases: [{ id: 'installer-a-to-b', status: 'failed', executed: commands.length > 0, evidenceLevel: 'installed-e2e', assertions: [],
      evidenceFiles: artifacts.map(entry => entry.relativePath), diagnostics: [failure.message, ...(scratch ? [`Owned recovery target retained: ${scratch}`] : [])] }] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input;
    if (process.argv[2] === '--probe-input' && process.argv[3] && process.argv.length === 4) input = JSON.parse(await readFile(process.argv[3], 'utf8'));
    else if (process.argv[2] === '--manifest' && process.argv[3] && process.argv.length === 4) {
      const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url))), runId = randomUUID();
      const evidenceRoot = join(repositoryRoot, 'output/update/installed-direct', runId);
      const head = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: repositoryRoot, timeoutMs: 10000 });
      input = { repositoryRoot, evidenceRoot, runId, headSha: head.stdout.trim(), installedConfigPath: process.argv[3] };
    } else throw new Error('Usage: node scripts/update/installed-a-to-b.mjs --manifest <approved-manifest.json>');
    const report = await runInstalledProbe(input);
    await writeFile(join(input.evidenceRoot, 'probe.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ status: report.status, report: join(input.evidenceRoot, 'probe.json'), blockers: report.blockers }) + '\n');
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; }
}
