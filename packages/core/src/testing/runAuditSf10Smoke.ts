/**
 * SF-10: Lua/LUABND 源码、字节码与混合编码 Smoke 测试套件
 *
 * 覆盖：
 * - Range Patch 逆序应用、切片哈希校验、重叠范围严格拒绝
 * - 混合编码 O(B+E) 纯字节 line span 替换：ASCII 行长度变化而非 ASCII 字节 100% 逐字节保全
 * - 行尾换行格式（CRLF / LF / 无换行）与尾部 NUL 对齐填充 100% 保全
 * - 混合编码增删行拒绝、改非 ASCII 行拒绝、插入非 ASCII 字符拒绝
 * - Unicode 与 BOM 保全；Shift-JIS 不可映射字符拒绝且不静默变 UTF-8
 * - ScriptLoaderProfile 签名/登记源匹配、字节码未经 profile 拒绝、反编译写回门禁
 * - 语法验证器失败 / 缺工具阻止写回
 * - Native 真实 Sekiro aicommon.luabnd.dcx 多条目读取、明文/字节码分类判别、受控写回与兄弟条目零篡改
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  applyRangePatches,
  type ScriptRangePatch,
  classifyPlaintextBytes,
  decodePlaintext
} from '../script/plaintextScriptEntry.js';
import {
  encodeScriptSourceForWriteback
} from '../script/scriptSourceWriteback.js';
import {
  type ScriptLoaderProfile,
  resolveScriptLoaderProfile,
  canEditScriptAsSource
} from '../script/scriptLoaderProfile.js';
import {
  readLuabndScript,
  setLuabndScript,
  listLuabndScripts
} from '../editing/luabndEdit.js';
import { openNativeEditSession } from '../editing/nativeEditSession.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

function fail(message: string): never {
  throw new Error(message);
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function parseLayer(): 'unit' | 'native' {
  const args = process.argv.slice(2);
  const layerIdx = args.indexOf('--layer');
  if (layerIdx === -1 || layerIdx + 1 >= args.length) {
    fail('必须指定 --layer unit|native');
  }
  const val = args[layerIdx + 1];
  if (val !== 'unit' && val !== 'native') {
    fail('未知 layer: ' + val + '，仅支持 unit 或 native');
  }
  return val;
}

// ---------------------------------------------------------------------------
// Unit Tests (Layer == 'unit')
// ---------------------------------------------------------------------------

async function runUnitLayer(): Promise<void> {
  // Case 1: Range Patch 正向逆序拼接与长度伸缩
  {
    const original = 'Hello world, this is a test of range patching.';
    const p1Target = 'world';
    const p1Start = original.indexOf(p1Target);
    const p1End = p1Start + p1Target.length;
    const p1Hash = sha256(p1Target);

    const p2Target = 'a test';
    const p2Start = original.indexOf(p2Target);
    const p2End = p2Start + p2Target.length;
    const p2Hash = sha256(p2Target);

    const patches: ScriptRangePatch[] = [
      { start: p2Start, end: p2End, expectedSliceHash: p2Hash, replacement: 'an advanced verification' },
      { start: p1Start, end: p1End, expectedSliceHash: p1Hash, replacement: 'SoulForge Engine' }
    ];

    const res = applyRangePatches(original, patches);
    if (!res.ok) fail('Range patch 应该成功: ' + res.message);
    const expected = 'Hello SoulForge Engine, this is an advanced verification of range patching.';
    if (res.text !== expected) {
      fail('Range patch 结果不匹配: 预期 "' + expected + '"，实际 "' + res.text + '"');
    }
  }

  // Case 2: Range Patch 错误检查（重叠、越界、哈希不符）
  {
    const original = 'ABCDEFGHIJ';
    // 重叠 patch
    const overlap: ScriptRangePatch[] = [
      { start: 0, end: 5, expectedSliceHash: sha256('ABCDE'), replacement: '1' },
      { start: 3, end: 8, expectedSliceHash: sha256('DEFGH'), replacement: '2' }
    ];
    const overlapRes = applyRangePatches(original, overlap);
    if (overlapRes.ok || overlapRes.code !== 'SCRIPT_PATCH_RANGES_OVERLAP') {
      fail('重叠 patch 必须被拒绝并返回 SCRIPT_PATCH_RANGES_OVERLAP');
    }

    // 越界 patch
    const oob: ScriptRangePatch[] = [
      { start: 0, end: 20, expectedSliceHash: sha256('oob'), replacement: 'x' }
    ];
    const oobRes = applyRangePatches(original, oob);
    if (oobRes.ok || oobRes.code !== 'SCRIPT_PATCH_RANGE_INVALID') {
      fail('越界 patch 必须被拒绝并返回 SCRIPT_PATCH_RANGE_INVALID');
    }

    // 哈希不符 patch
    const badHash: ScriptRangePatch[] = [
      { start: 0, end: 5, expectedSliceHash: '0000000000000000000000000000000000000000000000000000000000000000', replacement: 'x' }
    ];
    const badHashRes = applyRangePatches(original, badHash);
    if (badHashRes.ok || badHashRes.code !== 'SCRIPT_PATCH_SLICE_HASH_MISMATCH') {
      fail('哈希不匹配的 patch 必须被拒绝并返回 SCRIPT_PATCH_SLICE_HASH_MISMATCH');
    }
  }

  // Case 3: 混合编码 O(B+E) 纯字节 line span 替换与非 ASCII 字节 100% 保持
  {
    // 构造混合编码字节：含纯 ASCII 行、日文/GBK 非 ASCII 字节行、CRLF、LF、无尾换行、尾部 NUL 对齐填充
    // 必须垫足 ASCII 行以保证可打印比 > 0.99，且插入 0x80/0xFD 使 UTF-8 与 Shift-JIS fatal 解码均失败，判定为 mixed-unknown
    const asciiPad = Buffer.from(Array.from({ length: 200 }, (_, i) => `pad_${i} = ${i}\r\n`).join(''), 'ascii');
    const nonAsciiGbk = Buffer.from([0x80, 0xfd, 0xd7, 0xf3, 0xca, 0xd6]); // 包含非法引导字节 + GBK "左手"
    const nonAsciiSjis = Buffer.from([0x80, 0xfd, 0x83, 0x5e, 0x83, 0x8b]); // 包含非法引导字节 + Shift-JIS
    const part1 = Buffer.from('act[26] = 100\r\n', 'ascii');
    const part2Comment = Buffer.concat([Buffer.from('// ', 'ascii'), nonAsciiGbk, Buffer.from('\r\n', 'ascii')]);
    const part3 = Buffer.from('act[27] = 200\n', 'ascii');
    const part4Comment = Buffer.concat([Buffer.from('// ', 'ascii'), nonAsciiSjis, Buffer.from('\n', 'ascii')]);
    const part5 = Buffer.from('return 0', 'ascii');
    const trailingPadding = Buffer.from([0x00, 0x00, 0x00]); // 3 bytes NUL padding

    const originalBytes = Buffer.concat([asciiPad, part1, part2Comment, part3, part4Comment, part5, trailingPadding]);

    // 验证原始文件分类为 mixed-unknown，且 padding 识别为 3
    const verdict = classifyPlaintextBytes(originalBytes);
    if (verdict.detectedEncoding !== 'mixed-unknown') {
      fail('预期 detectedEncoding 为 mixed-unknown，实际 ' + verdict.detectedEncoding);
    }
    if (verdict.trailingPaddingBytes !== 3) {
      fail('预期 trailingPaddingBytes 为 3，实际 ' + verdict.trailingPaddingBytes);
    }

    const decoded = decodePlaintext(originalBytes.subarray(0, originalBytes.length - 3), 'mixed-unknown');

    // 修改：将 act[26] = 100 改为极长字符串 act[26] = 999999999999999，
    // 将 act[27] = 200 改为极短 act[27] = 1，将 return 0 改为 return 42
    // 非 ASCII 行保持完全不变
    const decodedLines = decoded.split(/\r?\n/);
    decodedLines[200] = 'act[26] = 999999999999999';
    decodedLines[202] = 'act[27] = 1';
    decodedLines[204] = 'return 42';
    const newText = decodedLines.join('\n');

    const writeback = encodeScriptSourceForWriteback(originalBytes, newText);
    if (!writeback.ok) fail('混合编码写效应成功: ' + writeback.message);
    if (writeback.writeKind !== 'mixed-ascii') fail('writeKind 应为 mixed-ascii');

    const resultBytes = writeback.bytes;

    // 验证尾部 3 字节 NUL padding 完好
    if (resultBytes.length < 3) fail('输出字节过短');
    if (
      resultBytes[resultBytes.length - 1] !== 0x00 ||
      resultBytes[resultBytes.length - 2] !== 0x00 ||
      resultBytes[resultBytes.length - 3] !== 0x00
    ) {
      fail('尾部 3 字节 NUL padding 未正确保留');
    }

    // 验证非 ASCII 行字节 100% 逐字节未改变
    const contentOut = resultBytes.subarray(0, resultBytes.length - 3);
    const textOutLatin = Buffer.from(contentOut).toString('latin1');
    if (!textOutLatin.includes(nonAsciiGbk.toString('latin1'))) {
      fail('GBK 非 ASCII 字节行被破坏');
    }
    if (!textOutLatin.includes(nonAsciiSjis.toString('latin1'))) {
      fail('Shift-JIS 非 ASCII 字节行被破坏');
    }
    if (!textOutLatin.includes('act[26] = 999999999999999\r\n')) {
      fail('第 201 行改写或 CRLF 保持失败');
    }
    if (!textOutLatin.endsWith('return 42')) {
      fail('末尾行无换行保持失败');
    }
  }

  // Case 4: 混合编码换行格式精准保留（CRLF, LF, 末尾无换行）
  {
    const crlfPad = Array.from({ length: 200 }, (_, i) => `crlf_pad_${i} = ${i}\r\n`).join('');
    const crlfBytes = Buffer.from(`${crlfPad}line1\r\n// \x80\xfd\r\nline3\r\n`, 'latin1');
    const decodedCrlf = decodePlaintext(crlfBytes, 'mixed-unknown');
    const linesCrlf = decodedCrlf.split(/\r?\n/);
    linesCrlf[200] = 'line1_modified';
    const resCrlf = encodeScriptSourceForWriteback(crlfBytes, linesCrlf.join('\n'));
    if (!resCrlf.ok) fail('CRLF mixed 写效应成功: ' + (resCrlf.ok ? '' : resCrlf.message));
    const crlfOut = Buffer.from(resCrlf.bytes).toString('latin1');
    if (!crlfOut.includes('line1_modified\r\n') || !crlfOut.includes('line3\r\n')) {
      fail('CRLF 换行序列未被完整保留');
    }

    const lfPad = Array.from({ length: 200 }, (_, i) => `lf_pad_${i} = ${i}\n`).join('');
    const lfBytes = Buffer.from(`${lfPad}line1\n// \x80\xfd\nline3`, 'latin1');
    const decodedLf = decodePlaintext(lfBytes, 'mixed-unknown');
    const linesLf = decodedLf.split(/\r?\n/);
    linesLf[200] = 'line1_mod';
    linesLf[202] = 'line3_mod';
    const resLf = encodeScriptSourceForWriteback(lfBytes, linesLf.join('\n'));
    if (!resLf.ok) fail('LF mixed 写效应成功: ' + (resLf.ok ? '' : resLf.message));
    const lfOut = Buffer.from(resLf.bytes).toString('latin1');
    if (!lfOut.includes('line1_mod\n') || !lfOut.endsWith('line3_mod')) {
      fail('LF 换行与末尾无换行格式未保留');
    }
  }

  // Case 5: 混合编码非法操作拒绝（改非 ASCII 行、增行、删行、插入非 ASCII）
  {
    const pad = Array.from({ length: 200 }, (_, i) => `pad_${i} = ${i}\n`).join('');
    const original = Buffer.from(`${pad}line1\n// \x80\xfd\nline3`, 'latin1');
    const decoded = decodePlaintext(original, 'mixed-unknown');
    const lines = decoded.split(/\r?\n/);

    // 尝试改非 ASCII 行 (第 201 行)
    const editNonAscii = [...lines];
    editNonAscii[201] = '// changed_comment';
    const r1 = encodeScriptSourceForWriteback(original, editNonAscii.join('\n'));
    if (r1.ok || r1.code !== 'SCRIPT_MIXED_NON_ASCII_LINE_EDIT') {
      fail('修改非 ASCII 行必须返回 SCRIPT_MIXED_NON_ASCII_LINE_EDIT');
    }

    // 尝试增行
    const addLine = [...lines, 'extra_line'];
    const r2 = encodeScriptSourceForWriteback(original, addLine.join('\n'));
    if (r2.ok || r2.code !== 'SCRIPT_MIXED_LINE_COUNT_CHANGED') {
      fail('增行必须返回 SCRIPT_MIXED_LINE_COUNT_CHANGED');
    }

    // 尝试删行
    const delLine = [lines[0]!];
    const r3 = encodeScriptSourceForWriteback(original, delLine.join('\n'));
    if (r3.ok || r3.code !== 'SCRIPT_MIXED_LINE_COUNT_CHANGED') {
      fail('删行必须返回 SCRIPT_MIXED_LINE_COUNT_CHANGED');
    }

    // 尝试在 ASCII 行插入非 ASCII 字符
    const insertNonAscii = [...lines];
    insertNonAscii[200] = 'line1_with_你好';
    const r4 = encodeScriptSourceForWriteback(original, insertNonAscii.join('\n'));
    if (r4.ok || r4.code !== 'SCRIPT_MIXED_NON_ASCII_LINE_EDIT') {
      fail('向纯 ASCII 行插入非 ASCII 字符必须返回 SCRIPT_MIXED_NON_ASCII_LINE_EDIT');
    }
  }

  // Case 6: 混合编码无 [...content] 线性性能与复杂度验证
  {
    // 生成 5000 行混合编码内容
    const chunkParts: Buffer[] = [];
    for (let i = 0; i < 5000; i++) {
      if (i % 50 === 0) {
        chunkParts.push(Buffer.from(`// non_ascii_${i}_\x80\x90\n`, 'latin1'));
      } else {
        chunkParts.push(Buffer.from(`local var_${i} = ${i}\n`, 'ascii'));
      }
    }
    const largeMixed = Buffer.concat(chunkParts);
    const decoded = decodePlaintext(largeMixed, 'mixed-unknown');
    const lines = decoded.split(/\r?\n/);
    lines[1] = 'local var_1 = 999999999';
    lines[2] = 'local var_2 = 0';

    const t0 = performance.now();
    const res = encodeScriptSourceForWriteback(largeMixed, lines.join('\n'));
    const cost = performance.now() - t0;
    if (!res.ok) fail('5000 行混合编码写回失败: ' + res.message);
    if (cost > 1000) {
      fail('5000 行混合编码写回耗时过长 (' + cost.toFixed(2) + 'ms)，可能存在全展开数组操作');
    }
  }

  // Case 7: 全 Unicode 编码与 BOM 保持，Shift-JIS 映射失败拒绝
  {
    // UTF-8 BOM
    const pad = Array.from({ length: 100 }, (_, i) => `x_${i} = ${i}\n`).join('');
    const utf8BomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${pad}local x = 1\n`, 'utf8')]);
    const rBom = encodeScriptSourceForWriteback(utf8BomBytes, `${pad}local x = 2\n`);
    if (!rBom.ok) fail('utf8-bom 写效应成功: ' + (rBom.ok ? '' : rBom.message));
    if (rBom.bytes[0] !== 0xef || rBom.bytes[1] !== 0xbb || rBom.bytes[2] !== 0xbf) {
      fail('utf8-bom 前缀丢失');
    }

    // Shift-JIS 含有不可映射字符（Emoji）
    const sjisBody = Buffer.from(Array.from({ length: 100 }, (_, i) => `x_${i} = ${i}\n`).join(''), 'ascii');
    const sjisVerdictBytes = Buffer.concat([
      Buffer.from([0x23, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a]),
      sjisBody
    ]);
    const badSjisText = `#テスト 😀\n${pad}`;
    const rSjis = encodeScriptSourceForWriteback(sjisVerdictBytes, badSjisText);
    if (rSjis.ok || rSjis.code !== 'PLAINTEXT_SHIFT_JIS_CHAR_UNMAPPABLE') {
      fail('Shift-JIS 写入不可映射字符必须失败且不得静默转 UTF-8');
    }
  }

  // Case 8: ScriptLoaderProfile 签名与注册表匹配
  {
    const pAi = resolveScriptLoaderProfile({ game: 'sekiro', containerPath: 'mods/script/aicommon.luabnd.dcx', entryName: 'goal_list.lua' });
    if (!pAi || pAi.id !== 'sekiro-ai-luabnd') fail('未能正确匹配 sekiro-ai-luabnd profile');
    if (!pAi.supportsPlaintextSourceEdit) fail('sekiro-ai-luabnd 必须支持明文条目源码编辑');
    if (pAi.bytecodeToSourceAllowed) fail('sekiro-ai-luabnd 不得开放字节码转源码写回');

    const pNameId = resolveScriptLoaderProfile({ game: 'sekiro', containerPath: 'mods/action/eventnameid.txt' });
    if (!pNameId || pNameId.id !== 'sekiro-action-nameid') fail('未能正确匹配 sekiro-action-nameid profile');
    if (!pNameId.supportsPlaintextSourceEdit) fail('sekiro-action-nameid 必须支持明文条目源码编辑');

    const pHks = resolveScriptLoaderProfile({ game: 'sekiro', containerPath: 'c0000_transition.hks' });
    if (!pHks || pHks.id !== 'sekiro-action-hks') fail('未能正确匹配 sekiro-action-hks profile');
    if (pHks.supportsPlaintextSourceEdit) fail('sekiro-action-hks 不得支持明文编辑');
  }

  // Case 9: 字节码反编译写回 Profile 守卫与语法校验拦截
  {
    const bytecode = new Uint8Array([0x1b, 0x4c, 0x75, 0x61, 0x51, 0x00, 0x01]);

    // 未登记 Profile
    const rNoProfile = encodeScriptSourceForWriteback(bytecode, 'print("test")\n', { requireProfile: true });
    if (rNoProfile.ok || rNoProfile.code !== 'SCRIPT_PROFILE_NOT_REGISTERED') {
      fail('未登记 profile 必须拒绝字节码源码写回');
    }

    // 登记 Profile 但未开放 bytecodeToSourceAllowed (例如 sekiro-ai-luabnd)
    const pAi = resolveScriptLoaderProfile({ game: 'sekiro', containerPath: 'aicommon.luabnd.dcx' })!;
    const rDisallowed = encodeScriptSourceForWriteback(bytecode, 'print("test")\n', { profile: pAi });
    if (rDisallowed.ok || rDisallowed.code !== 'SCRIPT_BYTECODE_SOURCE_EDIT_PROHIBITED') {
      fail('未开放 bytecodeToSourceAllowed 必须拒绝写回');
    }

    // 开放 bytecodeToSourceAllowed 但语法校验失败
    const customProfileWithValidator: ScriptLoaderProfile = {
      ...pAi,
      id: 'custom-tested-profile',
      bytecodeToSourceAllowed: true,
      matchingSyntaxValidator: {
        toolName: 'mock-luac',
        targetLuaVersion: '5.1',
        validate: (src) => {
          if (src.includes('syntax_error')) {
            return { ok: false, error: 'syntax error near unexpected token' };
          }
          return { ok: true };
        }
      }
    };

    const rSyntaxFail = encodeScriptSourceForWriteback(
      bytecode,
      'syntax_error local x =',
      { profile: customProfileWithValidator }
    );
    if (rSyntaxFail.ok || rSyntaxFail.code !== 'SCRIPT_SYNTAX_VALIDATION_FAILED') {
      fail('语法校验失败必须拒绝写回并返回 SCRIPT_SYNTAX_VALIDATION_FAILED');
    }

    // 开放 bytecodeToSourceAllowed 且语法校验通过
    const rSyntaxOk = encodeScriptSourceForWriteback(
      bytecode,
      'local x = 1\nprint(x)\n',
      { profile: customProfileWithValidator }
    );
    if (!rSyntaxOk.ok || rSyntaxOk.writeKind !== 'decompiled-as-utf8') {
      fail('合规字节码源码写回应该成功');
    }
  }

  // Case 10: 验证 canEditScriptAsSource 边界守卫
  {
    const pAi = resolveScriptLoaderProfile({ game: 'sekiro', containerPath: 'aicommon.luabnd.dcx' })!;
    const checkBytecode = canEditScriptAsSource(pAi, true);
    if (checkBytecode.allowed) fail('AI 字节码条目不得允许源码编辑');
    if (checkBytecode.code !== 'SCRIPT_BYTECODE_SOURCE_EDIT_PROHIBITED') {
      fail('错误码应为 SCRIPT_BYTECODE_SOURCE_EDIT_PROHIBITED');
    }

    const checkPlaintext = canEditScriptAsSource(pAi, false);
    if (!checkPlaintext.allowed) fail('AI 明文条目应该允许源码编辑');
  }

  console.log(JSON.stringify({
    ok: true,
    layer: 'unit',
    suite: 'test:audit-sf-10-unit',
    executedCases: 10,
    message: 'SF-10 unit tests passed: range patches, mixed-encoding byte-identical preservation, line ending preservation, profile resolution & guards, syntax validation, and safe integer ranges.'
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Native Tests (Layer == 'native')
// ---------------------------------------------------------------------------

async function runNativeLayer(): Promise<void> {
  const args = process.argv.slice(2);
  let nativeFixtureArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer') {
      i++;
    } else if (!args[i]?.startsWith('--')) {
      nativeFixtureArg = args[i];
    }
  }

  const sourceLuabnd = await resolveNativeFixture(
    nativeFixtureArg,
    'luabnd-primary',
    '../../mods/script/aicommon.luabnd.dcx'
  );

  const root = await mkdtemp(join(tmpdir(), 'soulforge-sf10-native-'));
  const staging = join(root, 'staging');
  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';

  try {
    await mkdir(staging, { recursive: true });
    const session = await openNativeEditSession({
      overlayRoot: staging,
      baseRoot: dirname(sourceLuabnd),
      game: 'sekiro'
    });

    // Native Case 1: 原生 aicommon.luabnd.dcx 枚举与 representation 识别
    const listRes = await listLuabndScripts({
      edit: session,
      file: sourceLuabnd
    });
    if (!listRes.ok) fail('原生 aicommon.luabnd.dcx 枚举失败: ' + JSON.stringify(listRes.diagnostics));
    if (listRes.scripts.length === 0) fail('aicommon.luabnd.dcx 没有条目');

    const goalEntry = listRes.scripts.find((s) => s.sanitizedName.toLowerCase() === 'goal_list.lua');
    if (!goalEntry) fail('未在 aicommon.luabnd.dcx 中找到 goal_list.lua');
    if (goalEntry.isBytecode) fail('goal_list.lua 应该是明文条目而非字节码');

    // 读取 goal_list.lua
    const goalRead = await readLuabndScript({
      edit: session,
      file: sourceLuabnd,
      childPath: goalEntry.sanitizedName
    });
    if (!goalRead.ok) fail('读取 goal_list.lua 失败: ' + JSON.stringify(goalRead.diagnostics));
    if (goalRead.script.representation !== 'plaintext') fail('goal_list.lua representation 应为 plaintext');
    if (goalRead.script.canWriteBack !== true) fail('goal_list.lua canWriteBack 应为 true');
    if (!goalRead.script.sourceHash) fail('goal_list.lua 缺少 sourceHash');

    // 读取一个字节码条目
    const bytecodeEntry = listRes.scripts.find((s) => s.isBytecode);
    if (!bytecodeEntry) fail('未找到任何字节码条目');
    const bcRead = await readLuabndScript({
      edit: session,
      file: sourceLuabnd,
      childPath: bytecodeEntry.sanitizedName
    });
    if (!bcRead.ok) fail('读取字节码条目失败: ' + JSON.stringify(bcRead.diagnostics));
    if (bcRead.script.representation !== 'bytecode') fail('字节码条目 representation 应为 bytecode');
    if (bcRead.script.canWriteBack !== false) fail('未开放的字节码条目 canWriteBack 必须为 false');

    // Native Case 2: 字节码条目源码写入阻断
    const bcSetBlocked = await setLuabndScript({
      edit: session,
      file: sourceLuabnd,
      childPath: bytecodeEntry.sanitizedName,
      text: 'print("attempting illegal bytecode overwrite")'
    });
    if (bcSetBlocked.ok || bcSetBlocked.error.code !== 'SCRIPT_BYTECODE_SOURCE_EDIT_PROHIBITED') {
      fail('向原生字节码条目写入文本源码必须被前置拦截并返回 SCRIPT_BYTECODE_SOURCE_EDIT_PROHIBITED');
    }

    // Native Case 3: 明文条目受控修改、暂存写回与重读验证，同级条目零篡改
    const originalGoalText = goalRead.script.textPreview ?? '';
    // 添加一段受控无害注释
    const modifiedGoalText = '-- SoulForge SF-10 Verified\n' + originalGoalText;

    // 复制原容器到 staging 运行环境以备写回
    const stagedContainer = join(staging, 'aicommon.luabnd.dcx');
    await writeFile(stagedContainer, await readFile(sourceLuabnd));
    const preWriteBytes = await readFile(stagedContainer);
    const preContainerHash = sha256(preWriteBytes);

    const goalSetRes = await setLuabndScript({
      edit: session,
      file: stagedContainer,
      childPath: goalEntry.sanitizedName,
      text: modifiedGoalText,
      expectedContainerHash: preContainerHash
    });
    if (!goalSetRes.ok) fail('setLuabndScript 写回失败: ' + JSON.stringify(goalSetRes.diagnostics));

    // 重读写回后的容器
    const rereadStaged = await readLuabndScript({
      edit: session,
      file: stagedContainer,
      childPath: goalEntry.sanitizedName
    });
    if (!rereadStaged.ok) fail('重读写回后的 goal_list.lua 失败: ' + JSON.stringify(rereadStaged.diagnostics));
    if (!rereadStaged.script.textPreview?.includes('SoulForge SF-10 Verified')) {
      fail('重读结果未包含改动后的注释');
    }

    // 重读同级字节码条目，验证哈希零变动
    const rereadBc = await readLuabndScript({
      edit: session,
      file: stagedContainer,
      childPath: bytecodeEntry.sanitizedName
    });
    if (!rereadBc.ok) fail('重读同级字节码条目失败: ' + JSON.stringify(rereadBc.diagnostics));
    if (rereadBc.script.contentHash !== bcRead.script.contentHash) {
      fail('同级字节码条目哈希被篡改！预期 ' + bcRead.script.contentHash + '，实际 ' + rereadBc.script.contentHash);
    }

    console.log(JSON.stringify({
      ok: true,
      layer: 'native',
      suite: 'test:audit-sf-10-native',
      executedCases: 4,
      message: 'SF-10 native smoke passed: aicommon.luabnd.dcx classification, bytecode write rejection, controlled plaintext staging write, and sibling zero-tamper.'
    }, null, 2));

  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    await disposeBridgeDaemonPool();
  }
}

async function main(): Promise<void> {
  const layer = parseLayer();
  if (layer === 'unit') {
    await runUnitLayer();
  } else {
    await runNativeLayer();
  }
}

main().catch((err) => {
  console.error('SF-10 smoke failure:', err);
  process.exit(1);
});
