/**
 * 明文脚本条目的判定与源码级编辑输入校验。
 *
 * 为什么需要独立一层,而不是复用 scriptContainerEvidence 的分类:
 *
 * `classifyScriptEntry` 对所有 `.lua` / `.hks` 一律返回 `lua-bytecode`,明文条目
 * 只靠 `magicVerified=false` 区分。而那个字段来自**采样**——
 * `MAGIC_SAMPLE_LIMIT = 12` 按容器顺序只验前 12 条,实测
 * `543000_battle.lua`(条目索引 222)的 `magicVerified` 是 `undefined`,
 * 也就是「没验过」。拿一个没验过的条目当明文往里写文本,会把字节码写坏。
 *
 * 所以源码级写用的是**按需、逐条、看真实字节**的判定:要写哪个条目就验哪个,
 * 不接受采样结论,也不接受文件名白名单。文件名可以对得上而内容是字节码
 * ——mod 作者完全可能把编译产物塞成同名条目。
 *
 * ── 实测依据(2026-08-08,本机 Sekiro mod 工作区)──
 *
 * 扫 mods/script 下 11 个 luabnd 容器共 1179 个 `.lua`/`.hks` 条目:
 *   明文 3 个 —— goal_list.lua(21400 B)、543000_battle.lua(53813 B,
 *   在 aicommon.luabnd.dcx)、801000_battle.lua(120489 B,在
 *   **m25_00_00_00.luabnd.dcx**);
 *   字节码 1176 个。
 * 两类的可打印字节比例**完全不重叠**:明文 1.0000,字节码 0.2029–0.6079。
 * 判定阈值 0.99 落在这个真实间隔里,不是估计。
 *
 * 顺带修正两处既有记录:
 *   - scope.json 说 801000_battle.lua 在 aicommon.luabnd.dcx —— 实测不在,
 *     它在 m25_00_00_00.luabnd.dcx;
 *   - scriptContainerEvidence 头注把 logic_list.lua 举例为明文列表文件 ——
 *     实测它是 `\x1bLuaP` 字节码(可打印率 0.6121)。
 *
 * game 侧 12 个容器在本次扫描里全部读取失败(KRAK/Oodle 需要
 * oodleRuntimeRoot,未传)。这不影响本模块:源码级写只写 Mod 暂存区,
 * 原版游戏目录永远只读。但结论的覆盖面是 **mod 侧**,不是全量。
 */

import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

/* ------------------------------------------------------------------ */
/*  判定                                                              */
/* ------------------------------------------------------------------ */

/** Havok Script / Lua 字节码签名 `\x1bLua`。 */
const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61] as const;

/**
 * 明文判定的可打印字节比例阈值。
 *
 * 实测明文 1.0000、字节码上限 0.6079,阈值取 0.99 而不是取中点 0.8:
 * 判定要靠紧明文那一侧。落在 0.6–0.99 之间的东西是「说不清」,而说不清的
 * 条目必须被拒绝,不能被当成明文写入。
 */
export const PLAINTEXT_PRINTABLE_RATIO_THRESHOLD = 0.99;

/** 判定采样的字节上限。整文件扫一遍对 120 KB 也不慢,但上限让代价可预期。 */
export const PLAINTEXT_SAMPLE_BYTES = 64 * 1024;

export type PlaintextVerdictCode =
  | 'PLAINTEXT_CONFIRMED'
  | 'PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC'
  | 'PLAINTEXT_REJECTED_CONTAINS_NUL'
  | 'PLAINTEXT_REJECTED_LOW_PRINTABLE_RATIO'
  | 'PLAINTEXT_REJECTED_EMPTY';

export interface PlaintextVerdict {
  /** true 仅当该条目的真实字节确认为明文。 */
  isPlaintext: boolean;
  code: PlaintextVerdictCode;
  /** 可打印字节比例(基于采样)。 */
  printableRatio: number;
  /** 采样字节数(基于剥掉尾部填充后的内容)。 */
  sampledBytes: number;
  /** 总字节数(含尾部填充)。 */
  totalBytes: number;
  /**
   * 尾部 NUL 对齐填充的字节数。
   *
   * 实测三个 action/*nameid.txt 全都有(3 / 5 / 14 字节)。它属于容器对齐,
   * 不是文本内容;回写时必须原样保留,否则条目长度改变。
   */
  trailingPaddingBytes: number;
  /** 是否命中 `\x1bLua` 字节码签名。 */
  luaBytecodeMagic: boolean;
  /** 是否含 NUL 字节。 */
  containsNul: boolean;
  /** 判定用的编码;明文条目按实测可能是 Shift-JIS 而不是 UTF-8。 */
  detectedEncoding: PlaintextEncoding;
  diagnostics: StructuredDiagnostic[];
}

/**
 * 明文条目的编码。
 *
 * 这不是可有可无的细节:action 目录下三个 `*nameid.txt` 实测是 **Shift-JIS**
 * (CP932),首行就是一句日文注释
 * 「#BOM付きUTF8で保存された場合に一行目が解析不能になる…」。
 * 按 UTF-8 读进来会得到 U+FFFD 替换符,再写回去就把所有日文换成了问号,
 * 且字节长度改变。所以编码必须显式判定并在回写时用同一种。
 */
export type PlaintextEncoding = 'ascii' | 'utf8' | 'utf8-bom' | 'shift_jis';

/**
 * 按真实字节判定一个条目是否明文。
 *
 * 不看文件名、不看扩展名、不用采样结论。文件名可以对得上而内容是字节码。
 */
export function classifyPlaintextBytes(bytes: Uint8Array): PlaintextVerdict {
  const totalBytes = bytes.length;
  const luaBytecodeMagic = totalBytes >= LUA_SIGNATURE.length
    && LUA_SIGNATURE.every((byte, index) => bytes[index] === byte);

  // 尾部对齐填充必须先剥掉,再判 NUL。
  //
  // 实测三个 action/*nameid.txt **全都**以 NUL 结尾:eventnameid 3 个、
  // statenameid 5 个、variablenameid 14 个,全部紧贴文件末尾,是容器对齐填充,
  // 不是内容的一部分。把它们当「内容里有 NUL」会让三个明文条目全被拒。
  //
  // 这一处最初写成「采样前 64 KB 判 NUL」,而 eventnameid.txt 有 148048 字节
  // ——采样只覆盖前 44%,尾部填充落在采样窗口外,于是它「确认为明文」而
  // variablenameid.txt(13696 字节,整文件在窗口内)被拒。同一批文件得出
  // 相反结论,原因纯粹是文件大小。NUL 判定因此改为**扫全文件**:
  // 一个只看开头的判定,对「结尾被塞了东西」这件事完全失明。
  const paddingBytes = trailingNulCount(bytes);
  const contentEnd = totalBytes - paddingBytes;
  const content = bytes.subarray(0, contentEnd);

  let containsNul = false;
  for (const byte of content) {
    if (byte === 0) { containsNul = true; break; }
  }

  // 可打印比例仍按采样算(比例是统计量,前 64 KB 足以代表),但基数是
  // **剥掉填充后**的内容 —— 否则 14 字节填充会把 13696 字节文件的比例拉低。
  const sample = content.subarray(0, Math.min(PLAINTEXT_SAMPLE_BYTES, content.length));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1;
  }
  const printableRatio = sample.length === 0 ? 0 : printable / sample.length;
  const detectedEncoding = detectPlaintextEncoding(content);

  const base = {
    printableRatio,
    sampledBytes: sample.length,
    totalBytes,
    trailingPaddingBytes: paddingBytes,
    luaBytecodeMagic,
    containsNul,
    detectedEncoding
  };

  // 判定顺序按「最明确的拒绝理由优先」:字节码签名是结论性的,
  // 比例是统计性的。诊断里必须点名是哪一条不满足,否则调用方只知道
  // 「不是明文」而不知道为什么。
  if (totalBytes === 0) {
    return {
      ...base,
      isPlaintext: false,
      code: 'PLAINTEXT_REJECTED_EMPTY',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'PLAINTEXT_REJECTED_EMPTY',
        message: '条目为空,无法判定是否明文。空条目不接受源码级编辑。'
      })]
    };
  }
  if (luaBytecodeMagic) {
    return {
      ...base,
      isPlaintext: false,
      code: 'PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC',
        message: '条目以 \\x1bLua 字节码签名开头,是编译产物。'
          + ' 字节码条目只允许整文件替换,不允许源码级编辑'
          + '(V0.5 无 HKS 重编译器)。'
      })]
    };
  }
  if (containsNul) {
    return {
      ...base,
      isPlaintext: false,
      code: 'PLAINTEXT_REJECTED_CONTAINS_NUL',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'PLAINTEXT_REJECTED_CONTAINS_NUL',
        message: '条目含 NUL 字节,不是文本。按文本改写会破坏内容。'
      })]
    };
  }
  if (printableRatio < PLAINTEXT_PRINTABLE_RATIO_THRESHOLD) {
    return {
      ...base,
      isPlaintext: false,
      code: 'PLAINTEXT_REJECTED_LOW_PRINTABLE_RATIO',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'PLAINTEXT_REJECTED_LOW_PRINTABLE_RATIO',
        message: `可打印字节比例 ${printableRatio.toFixed(4)} 低于阈值 `
          + `${PLAINTEXT_PRINTABLE_RATIO_THRESHOLD}。实测明文为 1.0000、`
          + '字节码上限 0.6079;落在两者之间的条目判定不明确,一律拒绝——'
          + '说不清的内容不该被当作文本写入。'
      })]
    };
  }
  return {
    ...base,
    isPlaintext: true,
    code: 'PLAINTEXT_CONFIRMED',
    diagnostics: [createDiagnostic({
      severity: 'info',
      code: 'PLAINTEXT_CONFIRMED',
      message: `条目确认为明文:${totalBytes} 字节,可打印比例 `
        + `${printableRatio.toFixed(4)},编码 ${detectedEncoding}。`
    })]
  };
}

/**
 * 判定明文条目的编码。
 *
 * 顺序有讲究:先看 BOM(确定性),再看是否纯 ASCII(两种编码下字节相同,
 * 标成 ascii 让调用方知道无需转码),再试 UTF-8 严格解码。UTF-8 严格解码
 * 失败而字节又都是文本,就按 Shift-JIS 处理 —— 这是本项目语料的实际情况
 * (action/*nameid.txt),不是通用推断。
 */
export function detectPlaintextEncoding(bytes: Uint8Array): PlaintextEncoding {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf8-bom';
  }
  let highBit = false;
  for (const byte of bytes) {
    if (byte >= 0x80) { highBit = true; break; }
  }
  if (!highBit) return 'ascii';
  try {
    // fatal 模式下非法序列抛异常，而不是静默替换成 U+FFFD。
    // 非 fatal 会让 Shift-JIS 内容「解码成功」但内容已被替换符污染。
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf8';
  } catch {
    return 'shift_jis';
  }
}

/**
 * 用判定出的编码解码明文条目。
 *
 * Shift-JIS 走 TextDecoder('shift_jis')。Node 内置 ICU 支持该标签;
 * 不支持时抛出而不是退回 UTF-8 —— 静默退回会产出替换符,而那些替换符
 * 一旦写回就永久替换掉了原文的日文。
 */
export function decodePlaintext(bytes: Uint8Array, encoding: PlaintextEncoding): string {
  if (encoding === 'shift_jis') {
    return new TextDecoder('shift_jis', { fatal: false }).decode(bytes);
  }
  if (encoding === 'utf8-bom') {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/* ------------------------------------------------------------------ */
/*  编码回写                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把编辑后的文本编回字节。
 *
 * ── 为什么 Shift-JIS 是受限的 ──
 *
 * 实测:Node 内置 `TextDecoder` 支持 `shift_jis`,但 `TextEncoder` 的 encoding
 * **固定为 utf-8**(传参数也无效,实测 `new TextEncoder('shift_jis').encoding`
 * 仍返回 `'utf-8'`),而本仓库没有 iconv 类依赖。
 *
 * 也就是说 Shift-JIS 方向**没有编码器**。若无视这一点做「解码 → 改文本 →
 * 按 UTF-8 编回」,结果是所有日文字节被替换:
 * action/*nameid.txt 首行那句「#BOM付きUTF8で…」会变成一串不同的字节,
 * 文件长度和内容双双改变,而这不会有任何报错。
 *
 * 所以对 Shift-JIS 条目只允许**纯 ASCII 结果**:新文本里每个码位都 < 0x80 时,
 * Shift-JIS 与 UTF-8 的字节表示相同,写回是无损的。一旦新文本含非 ASCII
 * 字符就必须拒绝,并说清原因 —— 拒绝一个改不了的编辑,好过静默写坏文件。
 *
 * 这条限制在 V0.5 是真实边界,不是偷懒:补一个 CP932 编码表是可做的,但那
 * 属于新增能力,需要单独的证据与裁定。
 */
export type PlaintextEncodeResult =
  | { ok: true; bytes: Uint8Array; encoding: PlaintextEncoding }
  | { ok: false; code: string; message: string; diagnostics: StructuredDiagnostic[] };

export function encodePlaintext(text: string, encoding: PlaintextEncoding): PlaintextEncodeResult {
  const nonAscii = firstNonAsciiIndex(text);
  if (encoding === 'shift_jis') {
    if (nonAscii >= 0) {
      const code = 'PLAINTEXT_SHIFT_JIS_ENCODE_UNSUPPORTED';
      const message = `该条目是 Shift-JIS(CP932)编码,而本版没有 Shift-JIS 编码器`
        + `(Node 的 TextEncoder 固定输出 UTF-8,仓库无 iconv 依赖)。`
        + ` 新内容第 ${nonAscii} 个字符是非 ASCII 字符 `
        + `${JSON.stringify(text[nonAscii])},按 UTF-8 写回会改变原文的日文字节。`
        + ' 只允许结果为纯 ASCII 的编辑;需要写入非 ASCII 内容时,'
        + '请改用整文件替换并自行提供正确编码的字节。';
      return {
        ok: false,
        code,
        message,
        diagnostics: [createDiagnostic({ severity: 'error', code, message })]
      };
    }
    // 纯 ASCII 时两种编码字节一致,写回无损。
    return { ok: true, bytes: new TextEncoder().encode(text), encoding };
  }
  if (encoding === 'utf8-bom') {
    const body = new TextEncoder().encode(text);
    const withBom = new Uint8Array(body.length + 3);
    withBom[0] = 0xef;
    withBom[1] = 0xbb;
    withBom[2] = 0xbf;
    withBom.set(body, 3);
    return { ok: true, bytes: withBom, encoding };
  }
  // ascii 与 utf8 都由 UTF-8 编码器覆盖;ascii 条目写入非 ASCII 时编码会
  // 自然升级为 UTF-8 多字节序列,这对 .lua 明文是安全的(Lua 源码按字节读)。
  return { ok: true, bytes: new TextEncoder().encode(text), encoding };
}

/** 统计紧贴文件末尾的连续 NUL 字节数。 */
export function trailingNulCount(bytes: Uint8Array): number {
  let count = 0;
  for (let index = bytes.length - 1; index >= 0 && bytes[index] === 0; index -= 1) {
    count += 1;
  }
  return count;
}

function firstNonAsciiIndex(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x80) return index;
  }
  return -1;
}
