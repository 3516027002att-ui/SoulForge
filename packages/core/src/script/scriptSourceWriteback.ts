/**
 * 脚本 IDE 写回：打开时用哪套解码，保存必须用回那套。
 *
 * 明文：ascii / utf8 / utf8-bom / shift_jis（CP932）走 encodePlaintext。
 * 混合编码：只允许改纯 ASCII 行，非 ASCII 字节原样复制（O(B+E) 纯字节 line span 算法）。
 * Lua 字节码：受 ScriptLoaderProfile 守卫；当前 Sekiro HKS 的源码编译由
 * Bridge 完成，本通用字节级编码器不把文本冒充成 HKS 字节码。
 */
import { createDiagnostic, type StructuredDiagnostic } from '@soulforge/shared';
import {
  classifyPlaintextBytes,
  decodePlaintext,
  encodePlaintext,
  type PlaintextEncodeResult,
  type PlaintextEncoding
} from './plaintextScriptEntry.js';
import {
  type ScriptLoaderProfile,
  canEditScriptAsSource
} from './scriptLoaderProfile.js';

export type ScriptSourceWritebackKind = 'plaintext' | 'decompiled-as-utf8' | 'mixed-ascii';

export interface ScriptWritebackOptions {
  profile?: ScriptLoaderProfile;
  requireProfile?: boolean;
}

export type ScriptSourceWritebackResult =
  | {
      ok: true;
      bytes: Uint8Array;
      encoding: PlaintextEncoding | 'utf8';
      writeKind: ScriptSourceWritebackKind;
    }
  | {
      ok: false;
      code: string;
      message: string;
      diagnostics: StructuredDiagnostic[];
    };

function fail(code: string, message: string): ScriptSourceWritebackResult {
  return {
    ok: false,
    code,
    message,
    diagnostics: [createDiagnostic({ severity: 'error', code, message })]
  };
}

function isPureAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}

function appendPadding(bytes: Uint8Array, padding: number): Uint8Array {
  if (padding <= 0) return bytes;
  const out = new Uint8Array(bytes.length + padding);
  out.set(bytes);
  return out;
}

function encodeFail(code: string, message: string): PlaintextEncodeResult {
  return {
    ok: false,
    code,
    message,
    diagnostics: [createDiagnostic({ severity: 'error', code, message })]
  };
}

interface ByteLineSpan {
  start: number;
  end: number;
  newlineStart: number;
  newlineEnd: number;
  isAscii: boolean;
}

function scanByteLineSpans(content: Uint8Array): ByteLineSpan[] {
  const spans: ByteLineSpan[] = [];
  let lineStart = 0;
  let isAscii = true;
  const len = content.length;

  for (let i = 0; i < len; i++) {
    const b = content[i]!;
    if (b >= 0x80) {
      isAscii = false;
    }
    if (b === 0x0a) {
      let lineEnd = i;
      let newlineStart = i;
      if (i > lineStart && content[i - 1] === 0x0d) {
        lineEnd = i - 1;
        newlineStart = i - 1;
      }
      spans.push({
        start: lineStart,
        end: lineEnd,
        newlineStart,
        newlineEnd: i + 1,
        isAscii
      });
      lineStart = i + 1;
      isAscii = true;
    }
  }
  if (lineStart <= len) {
    spans.push({
      start: lineStart,
      end: len,
      newlineStart: len,
      newlineEnd: len,
      isAscii
    });
  }
  return spans;
}

function encodeMixedAsciiLines(content: Uint8Array, newText: string): PlaintextEncodeResult {
  const spans = scanByteLineSpans(content);
  const newLines = newText.split(/\r?\n/);

  if (newLines.length !== spans.length) {
    return encodeFail(
      'SCRIPT_MIXED_LINE_COUNT_CHANGED',
      '该条目是混合编码（日文/GBK 等和非 ASCII 混在一起）。只能改纯 ASCII 行，不能增删行。'
    );
  }

  const changed: boolean[] = new Array(spans.length);

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const newLine = newLines[i]!;

    if (span.isAscii) {
      const origLen = span.end - span.start;
      let isSame = origLen === newLine.length;
      if (isSame) {
        for (let j = 0; j < origLen; j++) {
          if (content[span.start + j] !== newLine.charCodeAt(j)) {
            isSame = false;
            break;
          }
        }
      }
      if (!isSame) {
        if (!isPureAscii(newLine)) {
          return encodeFail(
            'SCRIPT_MIXED_NON_ASCII_LINE_EDIT',
            `第 ${i + 1} 行含非 ASCII 或与原字节对不齐。混合编码文件只能改纯 ASCII 行。`
          );
        }
        changed[i] = true;
      } else {
        changed[i] = false;
      }
    } else {
      // Non-ASCII line. Decode only this line to check whether caller kept it identical.
      const origDecoded = decodePlaintext(content.subarray(span.start, span.end), 'mixed-unknown');
      if (newLine !== origDecoded) {
        return encodeFail(
          'SCRIPT_MIXED_NON_ASCII_LINE_EDIT',
          `第 ${i + 1} 行含非 ASCII 或与原字节对不齐。混合编码文件只能改纯 ASCII 行。`
        );
      }
      changed[i] = false;
    }
  }

  // Calculate exact total bytes
  let totalBytes = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const newlineLen = span.newlineEnd - span.newlineStart;
    if (changed[i]) {
      totalBytes += newLines[i]!.length + newlineLen;
    } else {
      totalBytes += (span.end - span.start) + newlineLen;
    }
  }

  // Single allocation and sequential copy: O(B + E)
  const out = new Uint8Array(totalBytes);
  let writePos = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const newlineLen = span.newlineEnd - span.newlineStart;
    if (changed[i]) {
      const str = newLines[i]!;
      for (let j = 0; j < str.length; j++) {
        out[writePos++] = str.charCodeAt(j);
      }
    } else {
      out.set(content.subarray(span.start, span.end), writePos);
      writePos += (span.end - span.start);
    }
    if (newlineLen > 0) {
      out.set(content.subarray(span.newlineStart, span.newlineEnd), writePos);
      writePos += newlineLen;
    }
  }

  return { ok: true, bytes: out, encoding: 'mixed-unknown' };
}

export function encodeScriptSourceForWriteback(
  originalBytes: Uint8Array,
  newText: string,
  options?: ScriptWritebackOptions
): ScriptSourceWritebackResult {
  const verdict = classifyPlaintextBytes(originalBytes);
  const padding = verdict.trailingPaddingBytes;
  const content = originalBytes.subarray(0, originalBytes.length - padding);

  if (verdict.luaBytecodeMagic) {
    // A text encoder cannot produce valid Havok Script bytecode.  The
    // first-party Bridge is the only HKS compiler authority; callers that
    // have source text must compile there before invoking a native writer.
    return fail(
      'SCRIPT_HKS_BRIDGE_REQUIRED',
      '当前条目是 Sekiro HKS 字节码，必须通过 SoulForge 内置 Bridge 编译器写回；'
        + '通用文本编码器不会把源码冒充为字节码。'
    );
  }

  if (!verdict.isPlaintext) {
    return fail(
      'SCRIPT_SOURCE_NOT_PLAINTEXT',
      '该条目不是明文，不能当源码写回。打开失败的条目仍然不能写。'
    );
  }

  if (options?.requireProfile || options?.profile !== undefined) {
    const check = canEditScriptAsSource(options.profile, false);
    if (!check.allowed) {
      return fail(
        check.code ?? 'SCRIPT_PLAINTEXT_SOURCE_EDIT_PROHIBITED',
        check.message ?? 'Profile 未开放该条目的明文源码编辑。'
      );
    }
  }

  if (verdict.detectedEncoding === 'mixed-unknown') {
    const mixed = encodeMixedAsciiLines(content, newText);
    if (!mixed.ok) {
      return { ok: false, code: mixed.code, message: mixed.message, diagnostics: mixed.diagnostics };
    }
    return {
      ok: true,
      bytes: appendPadding(mixed.bytes, padding),
      encoding: 'mixed-unknown',
      writeKind: 'mixed-ascii'
    };
  }

  const encoded = encodePlaintext(newText, verdict.detectedEncoding);
  if (!encoded.ok) {
    return { ok: false, code: encoded.code, message: encoded.message, diagnostics: encoded.diagnostics };
  }
  return {
    ok: true,
    bytes: appendPadding(encoded.bytes, padding),
    encoding: encoded.encoding,
    writeKind: 'plaintext'
  };
}
