#!/usr/bin/env node
/**
 * Bridge 写盘边界门禁。
 *
 * 守的是硬约束 2/3：原版游戏目录永远只读，且 Mod 工作区不得被写入旁路文件。
 * Bridge 侧的执行点是 BridgeDaemonHost 对 options.outputPath 做
 * writable-root 校验——但那段校验此前是六个 Equals 串成的 if 链，而
 * extract-bnd4-child 同样按 outputPath 落盘却漏在链外。
 *
 * 漏掉的表现不是报错，是**没有校验**：输出路径只受 allowedRoots 约束，而
 * allowedRoots 必须包含原版游戏目录（Oodle 需要从那里加载 DLL），于是指向游戏
 * 目录的 outputPath 会被放行。实测确认过可以这样写出文件。
 *
 * 为什么必须是运行期门禁而不是源码扫描：
 *  - 「命令是否写盘」是运行期行为。源码里搜 File.WriteAllBytes 只能告诉你哪些
 *    文件写盘，不能告诉你哪条命令在哪个校验分支里；
 *  - 静态扫描抓不到「校验通过但 writer 绕回原始 options.outputPath」这类等价
 *    路径逃逸——那需要真的发一次越界请求，看有没有文件落地。
 *
 * 本门禁只用自造的微小 BND4-in-DCX 样本，不需要真实游戏语料，因此可以在公开
 * CI 真跑，不走诚实跳过。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

let declaredDiskWritingCommands = [];
let coveredWriteCommands = [];
let stagingWriteCodeContract = null;
const LABEL = 'bridge-write-boundary';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE_CANDIDATES = [
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Release', 'net10.0', 'win-x64', 'publish', 'SoulForge.Bridge.exe'),
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe')
];

function report(payload, exitCode) {
  const stream = exitCode === 0 ? console.log : console.error;
  stream(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

const exe = EXE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!exe) {
  // 产物缺失是环境问题而非通过：明确结构化跳过，不声称边界已验证。
  report({
    ok: null,
    gate: LABEL,
    status: 'skipped',
    reason: 'Bridge 可执行文件缺失，无法做运行期边界验证。',
    remedy: 'npm run bridge:build',
    skipSemantics: '结构跳过：未声称通过，也不计为失败。'
  }, 0);
}

/**
 * 构造一个最小的合法 BND4，再套 DFLT(zlib) DCX 外壳。
 *
 * 刻意不用真实游戏文件：本门禁验证的是路径边界，与格式深度无关。样本必须微小、
 * 合法构造并明确标记（硬约束 15）。
 */
function buildSyntheticBnd4(childName, childBytes) {
  // 名字按 UTF-8 + NUL：Bnd4NativeDocument.Read 用 ReadNullTerminatedUtf8 读它。
  const nameBytes = Buffer.from(`${childName}\0`, 'utf8');
  const headerSize = 0x40;
  const entrySize = 0x24;
  const entryCount = 1;
  const namesOffset = headerSize + entrySize * entryCount;
  const dataOffset = namesOffset + nameBytes.length;
  const total = dataOffset + childBytes.length;
  const bnd = Buffer.alloc(total);

  bnd.write('BND4', 0, 'ascii');
  bnd.writeInt32LE(0, 4);            // unk04
  bnd.writeInt32LE(0, 8);            // unk08
  bnd.writeInt32LE(entryCount, 0x0C);
  bnd.writeBigInt64LE(BigInt(headerSize), 0x10);
  bnd.write('07D7R6\0\0', 0x18, 'ascii');
  bnd.writeBigInt64LE(BigInt(entrySize), 0x20);
  bnd.writeBigInt64LE(BigInt(dataOffset), 0x28);
  bnd.writeInt32LE(0, 0x30);         // unicode/flags
  bnd.writeUInt8(0x74, 0x30);        // format flags (id + name + size)
  bnd.writeUInt8(1, 0x31);           // unicode = true
  bnd.writeInt32LE(0, 0x34);
  bnd.writeInt32LE(0, 0x38);
  bnd.writeInt32LE(0, 0x3C);

  // 条目布局按 Bnd4NativeDocument.Read 的偏移读法：
  // +0x00 flags(i32) +0x04 unk(i32) +0x08 compressedSize(i64)
  // +0x10 uncompressedSize(i64) +0x18 dataOffset(u32) +0x1C id(i32)
  // +0x20 nameOffset(u32)
  const e = headerSize;
  bnd.writeInt32LE(0x40, e);
  bnd.writeInt32LE(-1, e + 4);
  bnd.writeBigInt64LE(BigInt(childBytes.length), e + 8);
  bnd.writeBigInt64LE(BigInt(childBytes.length), e + 0x10);
  bnd.writeUInt32LE(dataOffset, e + 0x18);
  bnd.writeInt32LE(0, e + 0x1C);
  bnd.writeUInt32LE(namesOffset, e + 0x20);

  nameBytes.copy(bnd, namesOffset);
  childBytes.copy(bnd, dataOffset);
  return bnd;
}

function buildDfltDcx(payload) {
  const compressed = deflateSync(payload);
  const size = 0x4C + compressed.length;
  const dcx = Buffer.alloc(size);
  dcx.write('DCX\0', 0, 'ascii');
  dcx.writeInt32BE(0x10000, 4);
  dcx.writeInt32BE(0x18, 8);
  dcx.writeInt32BE(0x24, 0x0C);
  dcx.writeInt32BE(0x24, 0x10);
  dcx.writeInt32BE(0x2C, 0x14);
  dcx.write('DCS\0', 0x18, 'ascii');
  dcx.writeInt32BE(payload.length, 0x1C);
  dcx.writeInt32BE(compressed.length, 0x20);
  dcx.write('DCP\0', 0x24, 'ascii');
  dcx.write('DFLT', 0x28, 'ascii');
  dcx.writeInt32BE(0x20, 0x2C);
  dcx.writeUInt8(9, 0x30);
  dcx.writeInt32BE(0, 0x34);
  dcx.writeInt32BE(0, 0x38);
  dcx.writeInt32BE(0, 0x3C);
  dcx.writeInt32BE(0x00010100, 0x40);
  dcx.write('DCA\0', 0x44, 'ascii');
  dcx.writeInt32BE(8, 0x48);
  compressed.copy(dcx, 0x4C);
  return dcx;
}

/** NDJSON daemon 客户端：只解析终态帧（accepted/progress 是中间态）。 */
function openDaemon() {
  const child = spawn(exe, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.kind === 'progress' || frame.kind === 'request/accepted') continue;
      const settle = pending.get(frame.requestId);
      if (settle) { pending.delete(frame.requestId); settle(frame); }
    }
  });
  const send = (frame) => new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      pending.delete(frame.requestId);
      reject(new Error(`BRIDGE_FRAME_TIMEOUT: ${frame.requestId} 无终态响应；stderr=${stderr.slice(-400)}`));
    }, 60_000);
    pending.set(frame.requestId, (received) => { clearTimeout(timer); settle(received); });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
  return { child, send, getStderr: () => stderr };
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-write-boundary-'));
const readOnlyRoot = join(scratch, 'readonly-source');
const writableRoot = join(scratch, 'writable-staging');
mkdirSync(readOnlyRoot, { recursive: true });
mkdirSync(writableRoot, { recursive: true });

const childName = 'synthetic-boundary.param';
const childBytes = Buffer.from('SOULFORGE-SYNTHETIC-BOUNDARY-SAMPLE-NOT-NATIVE-AUTHORITY', 'ascii');
const sourceFile = join(readOnlyRoot, 'synthetic-boundary.parambnd.dcx');
writeFileSync(sourceFile, buildDfltDcx(buildSyntheticBnd4(childName, childBytes)));

const SESSION = 'write-boundary-session';
const findings = [];
const checks = [];
let daemon;

function check(name, condition, observed) {
  checks.push({ name, ok: Boolean(condition), observed });
  if (!condition) findings.push({ name, observed });
}

/**
 * 写入成功诊断码的 TS↔C# 契约。
 *
 * 守的形态：生产侧五条写路径把「写入是否成功」完全押在一个诊断码字面量上
 * （fmg/param/emevd/msbBridgeCommit.ts 与 writers/containerChildReplaceWriter.ts）。
 * 这些码由 C# BridgeCommandService 发出，两侧靠字面量恰好相同来耦合。
 * **C# 改一个码名，写入会静默变成 ok:false——无编译错误、无公开层测试失败**，
 * 用户侧症状只是「点保存没反应」。
 *
 * 为什么此前没人守：断言这些码的 9 个 smoke 全在 native 层，需要私有游戏语料，
 * 公开 CI 结构上跑不到（实测 bridge:verify:{fmg,param,emevd,msb} 与
 * runNative*Smoke 全部 tier=native）。于是最危险的那条耦合恰好落在公开验证之外。
 *
 * 判据分两层，缺一不可：
 *  1) **运行期观测**——真的做一次成功的 write-bnd4，断言响应里确实带
 *     BND4_STAGING_WRITE_VERIFIED。这是唯一能证明「码真的会被发出」的方式；
 *     文本对账只能证明两边字符串一样，证明不了它出现在成功路径上。
 *  2) **双向文本对账**——五个码在 shared 常量与 C# 源码里必须一一对应。
 *     运行期只覆盖 bnd4 一条（其余四个需要对应格式的合法样本，属 native 层），
 *     所以另外四个靠对账兜住改名。这一层的降级如实标注：它不是运行期证据。
 *
 * 为什么 bnd4 那条能在公开层真跑：本门禁的合成 BND4-in-DFLT-DCX 是合法容器，
 * write-bnd4 的 replace 突变只需要 expectedContainerHash + expectedChildHash，
 * 不需要任何真实游戏资产。
 */
async function assertStagingWriteVerifiedContract(daemon, fixture) {
  // 单一声明点：shared 常量。生产 TS 从此引用它而不是内联字面量。
  const sharedSource = readFileSync(
    resolve(root, 'packages', 'shared', 'src', 'bridge-protocol.ts'), 'utf8'
  );
  const blockMatch = /BRIDGE_STAGING_WRITE_VERIFIED_CODES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s*as const\)/
    .exec(sharedSource);
  if (blockMatch === null) {
    throw new Error(
      'STAGING_CODE_REGISTRY_UNREADABLE: 无法从 bridge-protocol.ts 解析'
      + ' BRIDGE_STAGING_WRITE_VERIFIED_CODES。提取失败必须失败关闭，否则本判据会消失。'
    );
  }
  const declared = new Map(
    [...blockMatch[1].matchAll(/(\w+)\s*:\s*'([A-Z0-9_]+)'/g)].map((m) => [m[1], m[2]])
  );
  if (declared.size === 0) {
    throw new Error('STAGING_CODE_REGISTRY_EMPTY: 常量解析结果为空。');
  }

  // C# 侧实际发出的码名，从 Diagnostic 构造调用里取。
  const serviceSource = readFileSync(
    resolve(root, 'bridge', 'SoulForge.Bridge', 'BridgeCommandService.cs'), 'utf8'
  );
  const csCodes = new Set(
    [...serviceSource.matchAll(/"([A-Z0-9]+_STAGING_WRITE_VERIFIED)"/g)].map((m) => m[1])
  );
  if (csCodes.size === 0) {
    throw new Error(
      'STAGING_CODE_CS_UNREADABLE: BridgeCommandService.cs 里没有任何'
      + ' *_STAGING_WRITE_VERIFIED 码。提取不到就等于判据消失，必须失败关闭。'
    );
  }

  const missingInCs = [...declared.values()].filter((code) => !csCodes.has(code));
  const missingInShared = [...csCodes].filter((code) => ![...declared.values()].includes(code));
  check(
    'staging 写入码：shared 常量与 C# 源码双向一致（文本级证据，非运行期观测）',
    missingInCs.length === 0 && missingInShared.length === 0,
    {
      evidence: 'source-text-only',
      declared: [...declared.values()],
      csEmitted: [...csCodes],
      missingInCs,
      missingInShared
    }
  );

  // 生产 TS 不得再内联这些码的字面量——内联会让单一声明点失去意义。
  const productionFiles = [
    'packages/core/src/editing/fmgBridgeCommit.ts',
    'packages/core/src/editing/flverBridgeCommit.ts',
    'packages/core/src/editing/paramBridgeCommit.ts',
    'packages/core/src/editing/emevdBridgeCommit.ts',
    'packages/core/src/editing/msbBridgeCommit.ts',
    'packages/core/src/writers/containerChildReplaceWriter.ts'
  ];
  const inlined = [];
  for (const relative of productionFiles) {
    const source = readFileSync(resolve(root, relative), 'utf8');
    for (const code of declared.values()) {
      // 只看字符串字面量形态；引用常量时源码里不会出现带引号的码名。
      if (source.includes(`'${code}'`) || source.includes(`"${code}"`)) {
        inlined.push({ file: relative, code });
      }
    }
  }
  check(
    'staging 写入码：生产写路径必须引用 shared 常量，不得内联字面量',
    inlined.length === 0,
    { inlined, checkedFiles: productionFiles.length }
  );

  // 运行期观测：真的成功写一次，断言码确实出现在成功路径上。
  const stagingOut = join(fixture.writableRoot, 'staging-code-observed.bnd4.dcx');
  const containerHash = createHash('sha256')
    .update(readFileSync(fixture.sourceFile)).digest('hex');
  const observed = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: 'staging-code-1',
    workspaceSessionId: SESSION,
    payload: {
      command: 'write-bnd4',
      filePath: fixture.sourceFile,
      options: {
        mutation: 'replace',
        childPath: fixture.childName,
        expectedContainerHash: containerHash,
        expectedChildHash: createHash('sha256').update(fixture.childBytes).digest('hex'),
        contentBase64: Buffer.from('SOULFORGE-SYNTHETIC-STAGING-CODE-PROBE', 'utf8').toString('base64'),
        outputPath: stagingOut
      }
    }
  });
  const observedCodes = (observed.payload?.result?.diagnostics ?? []).map((d) => d.code);
  check(
    'staging 写入码：成功的 write-bnd4 必须真的发出 BND4_STAGING_WRITE_VERIFIED（运行期观测）',
    observed.kind === 'result'
      && observed.payload?.result?.parseStatus !== 'failed'
      && observedCodes.includes(declared.get('bnd4')),
    {
      evidence: 'runtime-observed',
      kind: observed.kind,
      parseStatus: observed.payload?.result?.parseStatus ?? null,
      expected: declared.get('bnd4') ?? null,
      observedCodes,
      landed: existsSync(stagingOut)
    }
  );
  // 正向对照的反面：这条码只在真的写成功时出现。写入被拒时不得出现，
  // 否则「码存在」就不再等于「写入成功」，生产的成功判据会被彻底架空。
  const refusedOut = join(readOnlyRoot, 'staging-code-refused.bnd4.dcx');
  const refused = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: 'staging-code-2',
    workspaceSessionId: SESSION,
    payload: {
      command: 'write-bnd4',
      filePath: fixture.sourceFile,
      options: {
        mutation: 'replace',
        childPath: fixture.childName,
        expectedContainerHash: containerHash,
        expectedChildHash: createHash('sha256').update(fixture.childBytes).digest('hex'),
        contentBase64: Buffer.from('SOULFORGE-SYNTHETIC-STAGING-CODE-PROBE', 'utf8').toString('base64'),
        outputPath: refusedOut
      }
    }
  });
  const refusedCodes = (refused.payload?.result?.diagnostics ?? []).map((d) => d.code);
  check(
    'staging 写入码：被边界拒绝时不得出现该码（否则成功判据被架空）',
    !refusedCodes.includes(declared.get('bnd4')) && !existsSync(refusedOut),
    { kind: refused.kind, refusedCodes, landed: existsSync(refusedOut) }
  );
  if (existsSync(refusedOut)) rmSync(refusedOut, { force: true });
  if (existsSync(stagingOut)) rmSync(stagingOut, { force: true });
  stagingWriteCodeContract = {
    declared: Object.fromEntries(declared),
    runtimeObserved: [declared.get('bnd4')],
    reconciledByTextOnly: [...declared.values()].filter((c) => c !== declared.get('bnd4'))
  };
}

try {
  daemon = openDaemon();

  const handshake = await daemon.send({
    kind: 'handshake',
    protocolVersion: '1.0.0',
    requestId: 'handshake-1',
    workspaceSessionId: SESSION,
    payload: {
      // readOnlyRoot 模拟「必须可读但绝不可写」的原版游戏目录。
      allowedRoots: [readOnlyRoot, writableRoot],
      writableRoots: [writableRoot]
    }
  });
  if (handshake.kind !== 'handshake') {
    throw new Error(`BRIDGE_HANDSHAKE_FAILED: ${JSON.stringify(handshake.payload).slice(0, 300)}`);
  }

  /**
   * 每一个按 options.outputPath 落盘的命令都必须被边界拦住。
   *
   * 这份清单必须与 BridgeDaemonHost.cs 的 DiskWritingCommands 逐项对齐——
   * 下方 assertCoversAllDiskWritingCommands 会强制这一点。
   *
   * 此前只列了 3 个（extract-bnd4-child / write-bnd4 / export-tpf-texture），
   * 而 DiskWritingCommands 有 7 个：write-fmg / write-param / write-emevd /
   * write-msb **从未被越界测过**，且成功输出里的 coveredCommands 硬编码同样 3 个，
   * 于是门禁一边宣称「所有按 outputPath 落盘的命令都失败关闭」，一边只测了 3/7。
   *
   * 补齐这 4 个的成本很低，因为边界校验发生在**命令分派之前**
   * （BridgeDaemonHost.cs:284-300 只读 options.outputPath，不解析命令语义）：
   * 只要给出结构合法的 options，越界路径就必然在进入 writer 之前被拦下。
   * 各命令的 options 取其最小必需字段——它们不会被执行到，但缺字段会让请求在
   * 边界检查之前就以 BRIDGE_OUTPUT_PATH_REQUIRED 之外的原因失败，那样测到的
   * 就不是边界了。
   */
  const writeCommands = [
    { command: 'extract-bnd4-child', options: { childPath: childName } },
    { command: 'write-bnd4', options: { childPath: childName, newContentBase64: childBytes.toString('base64') } },
    { command: 'export-tpf-texture', options: { textureIndex: 0 } },
    // 以下 6 个此前未全覆盖。mutations/entries 给最小合法形态即可：
    // 边界在分派前生效，请求不会走到各自的 writer 实现里。
    { command: 'write-fmg', options: { entries: [{ id: 1, text: 'boundary-probe' }] } },
    { command: 'write-param', options: { mutations: [{ mutation: 'update', rowId: 1, fields: {} }] } },
    { command: 'write-emevd', options: { mutations: [] } },
    { command: 'write-msb', options: { mutations: [] } },
    { command: 'write-flver', options: { mutations: [] } },
    { command: 'write-gparam', options: { mutations: [] } },
    { command: 'write-tpf-texture-replace', options: { textureIndex: 0 } },
    { command: 'write-mtd-document', options: { paramId: '0', newValue: 'boundary-probe' } },
    { command: 'write-esd-document', options: { mutations: [] } },
    { command: 'write-tae-document', options: { mutations: [] } },
    { command: 'write-fxr-document', options: { mutations: [] } }
  ];

  /**
   * 防漂移：本门禁的 writeCommands 必须覆盖 C# 侧 DiskWritingCommands 的**全集**。
   *
   * 为什么必须机器校验而不是靠人对齐：漏一个命令的后果是它完全跳过 writable-root
   * 校验（BridgeDaemonHost.cs:284 只对集合内命令做边界检查），而这既不会有编译
   * 错误，也不会让任何测试失败，门禁照样全绿——正是本门禁注释里描述的事故形态。
   * 此前实测就是这个状态：集合 7 个，门禁测 3 个，4 个从未被越界测过。
   *
   * 判据直接从 C# 源码解析集合初始化块，因此新增写命令时若忘了补测，这里立刻报红。
   * 解析失败也失败关闭——提取不到集合就等于判据消失。
   */
  {
    const hostSource = readFileSync(
      resolve(root, 'bridge', 'SoulForge.Bridge', 'BridgeDaemonHost.cs'), 'utf8'
    );
    const blockMatch = /DiskWritingCommands\s*=\s*new\([^)]*\)\s*\{([^}]*)\}/s.exec(hostSource);
    if (blockMatch === null) {
      throw new Error(
        'WRITE_BOUNDARY_REGISTRY_UNREADABLE: 无法从 BridgeDaemonHost.cs 解析'
        + ' DiskWritingCommands 集合。提取失败必须失败关闭，否则覆盖面判据会消失。'
      );
    }
    const declared = [...blockMatch[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    if (declared.length === 0) {
      throw new Error('WRITE_BOUNDARY_REGISTRY_EMPTY: DiskWritingCommands 解析结果为空。');
    }
    const covered = new Set(writeCommands.map((entry) => entry.command));
    const missing = declared.filter((name) => !covered.has(name));
    const extra = [...covered].filter((name) => !declared.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        'WRITE_BOUNDARY_COVERAGE_DRIFT: 本门禁的 writeCommands 与 C# 侧'
        + ` DiskWritingCommands 不一致。未覆盖=${JSON.stringify(missing)}`
        + ` 多余=${JSON.stringify(extra)}。漏测的命令会完全跳过 writable-root 校验。`
      );
    }
    declaredDiskWritingCommands = declared;
    coveredWriteCommands = writeCommands.map((entry) => entry.command);
  }

  let requestId = 0;
  for (const { command, options } of writeCommands) {
    // 越界目标一：只读根（模拟原版游戏目录）。
    const forbidden = join(readOnlyRoot, `escape-${command}.bin`);
    const denied = await daemon.send({
      kind: 'request',
      protocolVersion: '1.0.0',
      requestId: `deny-${requestId += 1}`,
      workspaceSessionId: SESSION,
      payload: { command, filePath: sourceFile, options: { ...options, outputPath: forbidden } }
    });
    check(
      `${command}: outputPath 指向只读根必须被拒`,
      denied.kind === 'failed' && denied.payload?.code === 'BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS',
      { kind: denied.kind, code: denied.payload?.code ?? null }
    );
    check(
      `${command}: 被拒后只读根不得出现文件`,
      !existsSync(forbidden),
      { landed: existsSync(forbidden), path: forbidden }
    );
    if (existsSync(forbidden)) rmSync(forbidden, { force: true });

    // 越界目标二：用 .. 逃出 writable root。规范化后仍必须被拒。
    const traversal = join(writableRoot, '..', `traversal-${command}.bin`);
    const traversalDenied = await daemon.send({
      kind: 'request',
      protocolVersion: '1.0.0',
      requestId: `traverse-${requestId += 1}`,
      workspaceSessionId: SESSION,
      payload: { command, filePath: sourceFile, options: { ...options, outputPath: traversal } }
    });
    check(
      `${command}: outputPath 用 .. 逃出 writable root 必须被拒`,
      traversalDenied.kind === 'failed'
        && traversalDenied.payload?.code === 'BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS',
      { kind: traversalDenied.kind, code: traversalDenied.payload?.code ?? null }
    );
    const resolvedTraversal = resolve(traversal);
    check(
      `${command}: 逃逸目标不得出现文件`,
      !existsSync(resolvedTraversal),
      { landed: existsSync(resolvedTraversal), path: resolvedTraversal }
    );
    if (existsSync(resolvedTraversal)) rmSync(resolvedTraversal, { force: true });
  }

  // 正向对照：writable root 内必须真的能写成功。缺了这一条，把校验写成
  // 「一律拒绝」也能让上面全绿——那是另一种假门禁。
  const allowed = join(writableRoot, 'extracted-child.bin');
  const granted = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: 'allow-1',
    workspaceSessionId: SESSION,
    payload: {
      command: 'extract-bnd4-child',
      filePath: sourceFile,
      options: { childPath: childName, outputPath: allowed }
    }
  });
  const grantedOk = granted.kind === 'result'
    && granted.payload?.result?.parseStatus !== 'failed';
  check(
    'extract-bnd4-child: writable root 内必须写入成功（正向对照）',
    grantedOk && existsSync(allowed),
    {
      kind: granted.kind,
      parseStatus: granted.payload?.result?.parseStatus ?? null,
      landed: existsSync(allowed),
      diagnostics: granted.payload?.result?.diagnostics?.map((d) => d.code) ?? []
    }
  );
  if (existsSync(allowed)) {
    check(
      'extract-bnd4-child: 写出内容必须与容器内子项逐字节一致',
      readFileSync(allowed).equals(childBytes),
      { byteLength: readFileSync(allowed).length, expected: childBytes.length }
    );
  }

  await assertStagingWriteVerifiedContract(daemon, { sourceFile, childName, childBytes, writableRoot });

  // 未协商 writable root 时必须直接拒绝，而不是回落到 allowedRoots。
  const secondSession = openDaemon();
  try {
    const hs2 = await secondSession.send({
      kind: 'handshake',
      protocolVersion: '1.0.0',
      requestId: 'handshake-2',
      workspaceSessionId: 'no-writable-session',
      payload: { allowedRoots: [readOnlyRoot, writableRoot] }
    });
    if (hs2.kind !== 'handshake') throw new Error('BRIDGE_HANDSHAKE_FAILED (no-writable session)');
    const target = join(writableRoot, 'no-writable-root.bin');
    const refused = await secondSession.send({
      kind: 'request',
      protocolVersion: '1.0.0',
      requestId: 'no-writable-1',
      workspaceSessionId: 'no-writable-session',
      payload: {
        command: 'extract-bnd4-child',
        filePath: sourceFile,
        options: { childPath: childName, outputPath: target }
      }
    });
    check(
      '未协商 writableRoots 时写盘命令必须被拒（不得回落到 allowedRoots）',
      refused.kind === 'failed' && refused.payload?.code === 'BRIDGE_WRITABLE_ROOT_REQUIRED',
      { kind: refused.kind, code: refused.payload?.code ?? null }
    );
    check(
      '未协商 writableRoots 时不得出现文件',
      !existsSync(target),
      { landed: existsSync(target) }
    );
  } finally {
    secondSession.child.stdin.end();
    try { secondSession.child.kill(); } catch { /* 已退出 */ }
  }
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'WRITE_BOUNDARY_HARNESS_FAILED',
    message: error instanceof Error ? error.message : String(error),
    checks
  }, 1);
} finally {
  if (daemon) {
    daemon.child.stdin.end();
    try { daemon.child.kill(); } catch { /* 已退出 */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'BRIDGE_WRITE_BOUNDARY_VIOLATION',
    message: '写盘边界未按硬约束 2/3 失败关闭；outputPath 可落在协商范围之外。',
    passed: checks.length - findings.length,
    failed: findings.length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  assertions: checks.length,
  // 从实测清单派生，并已与 C# 侧 DiskWritingCommands 全集对账（见上方防漂移判据）。
  coveredCommands: coveredWriteCommands,
  declaredDiskWritingCommands,
  // 写入成功诊断码的 TS↔C# 契约。runtimeObserved 是运行期证据；
  // reconciledByTextOnly 只做了源码文本对账，**不构成运行期证据**——
  // 那四个码需要对应格式的合法样本，属 native 层。诚实标注降级，不假装同级。
  stagingWriteCodeContract,
  message: '所有按 outputPath 落盘的命令都对只读根与 .. 逃逸失败关闭，且 writable root 内正向写入成功；'
    + '写入成功诊断码与 C# 侧双向一致，其中 BND4 一条经运行期观测。',
  fixture: 'synthetic BND4-in-DFLT-DCX（微小、合法构造、明确标记，非 native authority）',
  nonClaim: '本门禁只证明路径边界，不证明任何格式的解析或写回 authority。'
}, 0);
