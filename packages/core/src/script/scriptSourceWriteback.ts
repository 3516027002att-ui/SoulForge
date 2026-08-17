/**
 * 脚本 IDE 写回：打开时用哪套解码，保存必须用回那套。
 *
 * 明文：ascii / utf8 / utf8-bom / shift_jis（CP932）走 encodePlaintext。
 * 混合编码：只允许改纯 ASCII 行，非 ASCII 字节原样复制。
 * Lua 字节码：社区流程是把反编译文本当明文写回，不要自研编译器。
 */
import { createDiagnostic, type StructuredDiagnostic } from '@soulforge/shared';
import {
  classifyPlaintextBytes,
  decodePlaintext,
  encodePlaintext,
  type PlaintextEncodeResult,
  type PlaintextEncoding
} from './plaintextScriptEntry.js';

export type ScriptSourceWritebackKind = 'plaintext' | 'decompiled-as-utf8' | 'mixed-ascii';

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

function encodeMixedAsciiLines(content: Uint8Array, newText: string): PlaintextEncodeResult {
  const oldDisplay = decodePlaintext(content, 'mixed-unknown');
  if (oldDisplay === newText) {
    return { ok: true, bytes: content, encoding: 'mixed-unknown' };
  }
  const oldLines = oldDisplay.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length !== newLines.length) {
    return encodeFail(
      'SCRIPT_MIXED_LINE_COUNT_CHANGED',
      '该条目是混合编码（日文/GBK 等和非 ASCII 混在一起）。只能改纯 ASCII 行，不能增删行。'
    );
  }
  const latin = Buffer.from(content).toString('latin1');
  const latinLines = latin.split('\n');
  if (latinLines.length !== oldLines.length) {
    return encodeFail(
      'SCRIPT_MIXED_NEWLINE_MISALIGN',
      '混合编码条目的换行无法与显示文本对齐，拒绝写回以免撕字节。'
    );
  }
  const next = latinLines.slice();
  for (let i = 0; i < oldLines.length; i += 1) {
    if (oldLines[i] === newLines[i]) continue;
    const oldLine = oldLines[i] ?? '';
    const newLine = newLines[i] ?? '';
    const latinLine = latinLines[i] ?? '';
    if (!isPureAscii(oldLine) || !isPureAscii(newLine) || !isPureAscii(latinLine) || latinLine !== oldLine) {
      return encodeFail(
        'SCRIPT_MIXED_NON_ASCII_LINE_EDIT',
        `第 ${i + 1} 行含非 ASCII 或与原字节对不齐。混合编码文件只能改纯 ASCII 行。`
      );
    }
    next[i] = newLine;
  }
  const edited = Buffer.from(next.join('\n'), 'latin1');
  const originalHigh = [...content].filter((byte) => byte >= 0x80);
  const editedHigh = [...edited].filter((byte) => byte >= 0x80);
  if (
    originalHigh.length !== editedHigh.length
    || originalHigh.some((byte, index) => byte !== editedHigh[index])
  ) {
    return encodeFail(
      'SCRIPT_MIXED_HIGH_BYTES_CHANGED',
      '写回会改动非 ASCII 字节，已拒绝。混合编码文件禁止整篇 UTF-8 碾压。'
    );
  }
  return { ok: true, bytes: new Uint8Array(edited), encoding: 'mixed-unknown' };
}

export function encodeScriptSourceForWriteback(
  originalBytes: Uint8Array,
  newText: string
): ScriptSourceWritebackResult {
  const verdict = classifyPlaintextBytes(originalBytes);
  const padding = verdict.trailingPaddingBytes;
  const content = originalBytes.subarray(0, originalBytes.length - padding);

  if (verdict.luaBytecodeMagic) {
    const body = new TextEncoder().encode(newText);
    return { ok: true, bytes: body, encoding: 'utf8', writeKind: 'decompiled-as-utf8' };
  }
  if (!verdict.isPlaintext) {
    return fail(
      'SCRIPT_SOURCE_NOT_PLAINTEXT',
      '该条目不是明文，不能当源码写回。打开失败的条目仍然不能写。'
    );
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
