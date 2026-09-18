/**
 * Renderer-safe binary helpers (no Node Buffer / fs).
 */

/**
 * P3 裁定：atob 输入必须严格校验。
 *
 * 用户实测：文本工作台整块被 `Failed to execute 'atob' on 'Window': The string
 * to be decoded contains characters outside of the Latin1 range.` 摔死——非
 * base64 内容（含非 Latin1 字符）被直接喂给了 atob。这里把「校验 + 解码」收敛
 * 到一个出口：输入不合法时抛**可行动**的结构化错误（错误边界能显示原因），
 * 而不是让浏览器抛一条看不懂的 DOMException。所有 atob 调用点必须经本函数。
 */
const BASE64_INVALID_MSG =
  'BASE64_INVALID_INPUT：传入 atob 的内容不是合法 base64（含非 Latin1 字符或非法字符）。'
  + ' 数据来源可能被误标为 base64；已拒绝解码以避免渲染崩溃。';

const B64_LOOKUP = new Uint8Array(256);
B64_LOOKUP.fill(255);
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (let i = 0; i < B64_CHARS.length; i += 1) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function decodeBase64ToUint8Array(base64: string): Uint8Array {
  let start = 0;
  let end = base64.length;
  while (start < end && base64.charCodeAt(start) <= 32) start += 1;
  while (end > start && base64.charCodeAt(end - 1) <= 32) end -= 1;
  if (start === end) return new Uint8Array(0);

  const rawLen = end - start;
  let pad = 0;
  if (base64.charCodeAt(end - 1) === 61) { // '='
    pad += 1;
    if (end - 2 >= start && base64.charCodeAt(end - 2) === 61) {
      pad += 1;
      if (end - 3 >= start && base64.charCodeAt(end - 3) === 61) {
        throw new Error(BASE64_INVALID_MSG);
      }
    }
  }

  const unpaddedLen = rawLen - pad;
  if (pad > 0 && rawLen % 4 !== 0) throw new Error(BASE64_INVALID_MSG);
  if (pad === 0 && rawLen % 4 === 1) throw new Error(BASE64_INVALID_MSG);

  const effectivePad = pad > 0 ? pad : (4 - (rawLen % 4)) % 4;
  const totalSlots = rawLen + (pad === 0 && effectivePad > 0 ? effectivePad : 0);
  const outLen = ((totalSlots * 3) >>> 2) - effectivePad;
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  const fullLimit = start + (unpaddedLen & ~3);
  for (let i = start; i < fullLimit; i += 4) {
    const c0 = base64.charCodeAt(i);
    const c1 = base64.charCodeAt(i + 1);
    const c2 = base64.charCodeAt(i + 2);
    const c3 = base64.charCodeAt(i + 3);
    if ((c0 | c1 | c2 | c3) >= 256) throw new Error(BASE64_INVALID_MSG);
    const a = B64_LOOKUP[c0]!;
    const b = B64_LOOKUP[c1]!;
    const c = B64_LOOKUP[c2]!;
    const d = B64_LOOKUP[c3]!;
    if ((a | b | c | d) === 255) throw new Error(BASE64_INVALID_MSG);
    out[outIdx++] = (a << 2) | (b >> 4);
    out[outIdx++] = ((b & 15) << 4) | (c >> 2);
    out[outIdx++] = ((c & 3) << 6) | d;
  }

  const rem = unpaddedLen % 4;
  if (rem === 2) {
    const c0 = base64.charCodeAt(fullLimit);
    const c1 = base64.charCodeAt(fullLimit + 1);
    if ((c0 | c1) >= 256) throw new Error(BASE64_INVALID_MSG);
    const a = B64_LOOKUP[c0]!;
    const b = B64_LOOKUP[c1]!;
    if ((a | b) === 255) throw new Error(BASE64_INVALID_MSG);
    out[outIdx++] = (a << 2) | (b >> 4);
  } else if (rem === 3) {
    const c0 = base64.charCodeAt(fullLimit);
    const c1 = base64.charCodeAt(fullLimit + 1);
    const c2 = base64.charCodeAt(fullLimit + 2);
    if ((c0 | c1 | c2) >= 256) throw new Error(BASE64_INVALID_MSG);
    const a = B64_LOOKUP[c0]!;
    const b = B64_LOOKUP[c1]!;
    const c = B64_LOOKUP[c2]!;
    if ((a | b | c) === 255) throw new Error(BASE64_INVALID_MSG);
    out[outIdx++] = (a << 2) | (b >> 4);
    out[outIdx++] = ((b & 15) << 4) | (c >> 2);
  }

  return out;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  return decodeBase64ToUint8Array(base64);
}

/** Loose base64 sanity check for user-supplied replacement bytes. */
export function isLikelyBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(trimmed);
}

/**
 * P3 裁定：把「可能是 hex 文本、可能是 base64、可能是误标的文本」统一转成
 * 安全的 base64 字节串。
 *
 * 只接受两种形态，其余一律安全降级为空（绝不把未知内容直接交给 atob——那正是
 * 「文本工作台被 atob 摔死」的入口形态）：
 * 1. toHexPreview 形态：`00000000  4d 53 42 44 ...  |MSBD....|` —— 逐行提取
 *    字节列（offset 后到 | 前的 2 位 hex），不再把 ascii 列混进去；
 * 2. 纯 hex 文本（可含空格/换行分隔）。
 * 奇数个 hex 位时截掉最后一位（旧行为 floor），不抛异常。
 */
export function hexTextToSafeBase64(hexText: string): string {
  let hex = '';
  for (const line of hexText.split('\n')) {
    const dumpMatch = /^[0-9a-f]{8}\s+((?:[0-9a-f]{2}\s+){1,47})\s*\|/i.exec(line);
    if (dumpMatch) {
      hex += dumpMatch[1]!.replace(/\s+/g, '');
      continue;
    }
    hex += line.replace(/[^0-9a-fA-F]/g, '');
  }
  if (hex.length % 2 !== 0) hex = hex.slice(0, -1);
  if (hex.length === 0) return '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return uint8ArrayToBase64(bytes);
}
