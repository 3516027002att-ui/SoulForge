import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixedNativeFixture {
  role:string;
  relativePath:string;
  sha256:string;
  byteLength:number;
  expected:Record<string,unknown>;
}
export type FixedNativeFixtureResult =
  | {status:'available';path:string;version:string;fixture:FixedNativeFixture}
  | {status:'unavailable';code:string;message:string;version?:string};

/** Correctness cases live in the existing versioned corpus manifest. Mutable
 * input bytes are hash-checked before being copied into the test-owned root. */
export async function materializeFixedNativeFixture(role:string,ownedRoot:string,explicitPath?:string,options:{manifestPath?:string;fixtureRoot?:string}={}):Promise<FixedNativeFixtureResult> {
  if(!/^[a-z0-9_-]+$/iu.test(role))throw new Error('FIXED_CORPUS_ROLE_INVALID');
  const manifestPath=options.manifestPath??fileURLToPath(new URL('../../../../testdata/corpus/sekiro-1.6.corpus-manifest.json',import.meta.url));
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as {correctnessFixtures?:{schemaVersion:string;version:string;fixtures:FixedNativeFixture[]}};
  const contract=manifest.correctnessFixtures;
  if(!contract||contract.schemaVersion!=='1.0.0'||!contract.version||!Array.isArray(contract.fixtures))throw new Error('FIXED_CORPUS_MANIFEST_INVALID');
  const matches=contract.fixtures.filter(fixture=>fixture.role===role);
  if(matches.length!==1)throw new Error(`FIXED_CORPUS_ROLE_INVALID: ${role}`);
  const fixture=matches[0]!;
  if(!/^[a-f0-9]{64}$/u.test(fixture.sha256)||!Number.isSafeInteger(fixture.byteLength)||fixture.byteLength<1||fixture.byteLength>64*1024*1024
    || !fixture.relativePath||isAbsolute(fixture.relativePath)||fixture.relativePath.split(/[\\/]/u).includes('..')||!fixture.expected||typeof fixture.expected!=='object'||Array.isArray(fixture.expected))throw new Error('FIXED_CORPUS_MANIFEST_INVALID');
  const fixtureRoot=options.fixtureRoot||process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()||process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if(!explicitPath&&!fixtureRoot)return {status:'unavailable',code:'FIXED_CORPUS_ROOT_MISSING',message:'The pinned local correctness corpus is not configured.',version:contract.version};
  let source:string;
  try{
    const candidate=explicitPath?resolve(explicitPath):resolve(fixtureRoot!,fixture.relativePath);
    source=await realpath(candidate);
    if(!explicitPath){const root=await realpath(resolve(fixtureRoot!));const rel=relative(root,source);if(rel.startsWith('..')||isAbsolute(rel))return {status:'unavailable',code:'FIXED_CORPUS_OUTSIDE_ROOT',message:'Pinned corpus resource escaped its configured root.',version:contract.version};}
  }catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return {status:'unavailable',code:'FIXED_CORPUS_MISSING',message:`Pinned corpus input is missing or unreadable: ${fixture.relativePath}`,version:contract.version};throw error;}
  // Verify the very bytes copied to the test, avoiding a hash/read TOCTOU.
  let handle:Awaited<ReturnType<typeof open>>|undefined;let bytes:Buffer;
  try{
    handle=await open(source,'r');
    if((await handle.stat()).size!==fixture.byteLength)return {status:'unavailable',code:'FIXED_CORPUS_HASH_MISMATCH',message:`Pinned corpus input size differs from version ${contract.version}: ${fixture.relativePath}`,version:contract.version};
    const bounded=Buffer.alloc(fixture.byteLength+1);let read=0;
    while(read<bounded.length){const result=await handle.read(bounded,read,bounded.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead;}
    bytes=bounded.subarray(0,read);
  }catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return {status:'unavailable',code:'FIXED_CORPUS_MISSING',message:`Pinned corpus input disappeared or became unreadable: ${fixture.relativePath}`,version:contract.version};throw error;
  }finally{await handle?.close();}
  if(bytes.length!==fixture.byteLength||createHash('sha256').update(bytes).digest('hex')!==fixture.sha256)return {status:'unavailable',code:'FIXED_CORPUS_HASH_MISMATCH',message:`Pinned corpus input differs from version ${contract.version}: ${fixture.relativePath}`,version:contract.version};
  const directory=join(ownedRoot,'fixed-corpus',role);await mkdir(directory,{recursive:true});
  const path=join(directory,basename(fixture.relativePath));await writeFile(path,bytes);
  return {status:'available',path,version:contract.version,fixture};
}

export function fixedFixtureNumber(fixture:FixedNativeFixture,key:string):number {
  const value=fixture.expected[key];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error(`FIXED_CORPUS_EXPECTATION_INVALID: ${key}`);return value;
}

/** Compare every kind/count with the pinned external oracle, not the reader's
 * own aggregate total. This remains a test verifier over native DTOs. */
export function assertFixedInstructionDistribution(fixture:FixedNativeFixture,observed:readonly {bank:number;id:number;count:number}[]):void {
  const expected=fixture.expected.distribution;
  if(!Array.isArray(expected)||expected.some(item=>!item||!['bank','id','count'].every(key=>Number.isSafeInteger(item[key])&&item[key]>=0)))throw new Error('FIXED_CORPUS_EXPECTATION_INVALID: distribution');
  const normalize=(items:readonly {bank:number;id:number;count:number}[])=>items.map(({bank,id,count})=>({bank,id,count})).sort((a,b)=>a.bank-b.bank||a.id-b.id);
  if(JSON.stringify(normalize(observed))!==JSON.stringify(normalize(expected)))throw new Error('FIXED_CORPUS_DISTRIBUTION_MISMATCH: native instruction kinds/counts differ from the external oracle.');
}

interface NativeFixtureEntry {
  fixtureId: string;
  localPath: string;
  sha256: string;
  testRole?: string;
}

interface NativeFixtureRegistry {
  schemaVersion: string;
  fixtures: NativeFixtureEntry[];
}

/**
 * 查询 registry 是否登记了某个 testRole。
 *
 * 为什么需要它：`resolveNativeFixture` 对「角色未登记」抛 ROLE_MISSING 是正确的
 * ——静默回落会让 smoke 假装验证过。对当前环境没有登记样本的能力，
 * 「本机没有该样本」是合法状态，应当诚实跳过而不是硬失败。两者必须由调用方
 * 区分，因为只有调用方知道该能力在本版是否属于必须验证的范围。
 *
 * 注意本函数只回答「有没有登记」，不做哈希与越界校验——一旦登记了，
 * 样本损坏或越界仍必须由 resolveNativeFixture 失败关闭，不能降级成跳过。
 *
 * 「registry 配置了但读不出来」必须抛错，不能返回 false：那是环境损坏，
 * 若降级成「未登记」就会把本该失败关闭的场景静默跳过。
 */
export async function nativeFixtureRoleRegistered(testRole: string): Promise<boolean> {
  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!registryPath || !fixtureRoot) return false;

  let registry: NativeFixtureRegistry;
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8')) as NativeFixtureRegistry;
  } catch (error) {
    throw new Error(
      `NATIVE_FIXTURE_REGISTRY_INVALID: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (registry.schemaVersion !== '1.0.0' || !Array.isArray(registry.fixtures)) {
    throw new Error('NATIVE_FIXTURE_REGISTRY_INVALID: schemaVersion/fixtures 不符合 1.0.0 契约。');
  }
  return registry.fixtures.some((item) => item.testRole === testRole);
}

export async function resolveNativeFixture(
  explicitPath: string | undefined,
  testRole: string,
  legacyRelativePath: string
): Promise<string> {
  if (explicitPath?.trim()) return resolve(explicitPath);

  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!registryPath || !fixtureRoot) return resolveLegacyNativeFixture(legacyRelativePath);

  let registry: NativeFixtureRegistry;
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8')) as NativeFixtureRegistry;
  } catch (error) {
    throw new Error(
      `NATIVE_FIXTURE_REGISTRY_INVALID: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (registry.schemaVersion !== '1.0.0' || !Array.isArray(registry.fixtures)) {
    throw new Error('NATIVE_FIXTURE_REGISTRY_INVALID: schemaVersion/fixtures 不符合 1.0.0 契约。');
  }

  const matches = registry.fixtures.filter((item) => item.testRole === testRole);
  if (matches.length === 0) {
    throw new Error(`NATIVE_FIXTURE_ROLE_MISSING: registry 中缺少 testRole=${testRole}。`);
  }
  if (matches.length > 1) {
    throw new Error(`NATIVE_FIXTURE_ROLE_AMBIGUOUS: registry 中 testRole=${testRole} 不唯一。`);
  }
  const fixture = matches[0]!;
  if (typeof fixture.fixtureId !== 'string' || !fixture.fixtureId.trim()
    || typeof fixture.localPath !== 'string' || !fixture.localPath.trim()) {
    throw new Error(`NATIVE_FIXTURE_ENTRY_INVALID: testRole=${testRole} 缺少 fixtureId/localPath。`);
  }
  if (!/^[a-f0-9]{64}$/i.test(fixture.sha256)) {
    throw new Error(`NATIVE_FIXTURE_HASH_INVALID: testRole=${testRole} 缺少合法 SHA-256。`);
  }

  const root = await realpath(resolve(fixtureRoot));
  const candidate = isAbsolute(fixture.localPath)
    ? resolve(fixture.localPath)
    : resolve(root, fixture.localPath);
  const path = await realpath(candidate);
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`NATIVE_FIXTURE_OUTSIDE_ROOT: testRole=${testRole} 越出 fixture root。`);
  }

  const actualHash = await sha256File(path);
  if (actualHash !== fixture.sha256.toLowerCase()) {
    throw new Error(`NATIVE_FIXTURE_HASH_MISMATCH: testRole=${testRole} 注册哈希与文件不一致。`);
  }
  return path;
}

/**
 * 无 registry 时仍允许既定的 smoke 命令使用只读真实游戏目录。
 * 旧的 legacy 路径形如 ../../mods/...，相对的是仓库 dist 目录；
 * 配置了 Sekiro 根后必须把它解释为 <gameRoot>/mods/...，否则命令会
 * 错误地落到仓库中不存在的 mods/，并把“没有走真实语料”误报成路径错误。
 */
function resolveLegacyNativeFixture(legacyRelativePath: string): string {
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!gameRoot || !/^(?:\.\.[\\/])/.test(legacyRelativePath)) {
    return resolve(legacyRelativePath);
  }

  const gameRelativePath = legacyRelativePath.replace(/^(?:\.\.[\\/])+/, '');
  return resolve(gameRoot, gameRelativePath);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
