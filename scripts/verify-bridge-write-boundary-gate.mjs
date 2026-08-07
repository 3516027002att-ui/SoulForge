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

let declaredDiskWritingCommands = [];
let coveredWriteCommands = [];
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
    // 以下 4 个此前完全未覆盖。mutations/entries 给最小合法形态即可：
    // 边界在分派前生效，请求不会走到各自的 writer 实现里。
    { command: 'write-fmg', options: { entries: [{ id: 1, text: 'boundary-probe' }] } },
    { command: 'write-param', options: { mutations: [{ mutation: 'update', rowId: 1, fields: {} }] } },
    { command: 'write-emevd', options: { mutations: [] } },
    { command: 'write-msb', options: { mutations: [] } }
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
  message: '所有按 outputPath 落盘的命令都对只读根与 .. 逃逸失败关闭，且 writable root 内正向写入成功。',
  fixture: 'synthetic BND4-in-DFLT-DCX（微小、合法构造、明确标记，非 native authority）',
  nonClaim: '本门禁只证明路径边界，不证明任何格式的解析或写回 authority。'
}, 0);
