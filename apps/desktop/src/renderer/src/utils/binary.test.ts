import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeBase64ToUint8Array,
  uint8ArrayToBase64,
  base64ToUint8Array,
  isLikelyBase64,
  hexTextToSafeBase64
} from './binary.js';

describe('binary utilities', () => {
  describe('decodeBase64ToUint8Array', () => {
    it('decodes empty and whitespace strings to empty Uint8Array', () => {
      assert.deepEqual(decodeBase64ToUint8Array(''), new Uint8Array(0));
      assert.deepEqual(decodeBase64ToUint8Array('   '), new Uint8Array(0));
      assert.deepEqual(decodeBase64ToUint8Array('\n\t\r'), new Uint8Array(0));
    });

    it('decodes standard padded base64 correctly', () => {
      const cases = [
        ['YQ==', [97]],
        ['YWI=', [97, 98]],
        ['YWJj', [97, 98, 99]],
        ['YWJjZA==', [97, 98, 99, 100]],
        ['YWJjZGU=', [97, 98, 99, 100, 101]],
        ['YWJjZGVm', [97, 98, 99, 100, 101, 102]]
      ];
      for (const [input, expected] of cases) {
        const decoded = decodeBase64ToUint8Array(input as string);
        assert.deepEqual(Array.from(decoded), expected);
      }
    });

    it('decodes unpadded base64 correctly', () => {
      // 'a' = 97 -> 'YQ'
      assert.deepEqual(Array.from(decodeBase64ToUint8Array('YQ')), [97]);
      // 'ab' = 97, 98 -> 'YWI'
      assert.deepEqual(Array.from(decodeBase64ToUint8Array('YWI')), [97, 98]);
    });

    it('roundtrips binary payloads with uint8ArrayToBase64', () => {
      const payload = new Uint8Array(2048);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (i * 17 + 3) & 0xff;
      }
      const b64 = uint8ArrayToBase64(payload);
      const restored = decodeBase64ToUint8Array(b64);
      assert.deepEqual(restored, payload);
    });

    it('rejects invalid characters, non-Latin1, and invalid padding with structured error', () => {
      const invalid = [
        'Y',          // len % 4 === 1 unpadded
        'YQ=',        // single pad on len 3
        'YQ===',      // 3 pads
        'YQ=a',       // char after pad
        'YWJj=',      // pad on len 4
        'YW=j',       // pad in middle
        'hello-world',// '-' is URL-safe base64, not standard base64
        '你好世界',   // non-Latin1
        'YWJj d=='    // internal space
      ];
      for (const input of invalid) {
        assert.throws(
          () => decodeBase64ToUint8Array(input),
          /BASE64_INVALID_INPUT/,
          `expected ${JSON.stringify(input)} to throw BASE64_INVALID_INPUT`
        );
      }
    });

    it('base64ToUint8Array is an alias for decodeBase64ToUint8Array', () => {
      assert.deepEqual(base64ToUint8Array('YWJj'), decodeBase64ToUint8Array('YWJj'));
    });
  });

  describe('isLikelyBase64', () => {
    it('returns true for valid base64 strings', () => {
      assert.equal(isLikelyBase64('YWJj'), true);
      assert.equal(isLikelyBase64('YQ=='), true);
      assert.equal(isLikelyBase64('  YWI=  '), true);
    });

    it('returns false for empty or invalid strings', () => {
      assert.equal(isLikelyBase64(''), false);
      assert.equal(isLikelyBase64('   '), false);
      assert.equal(isLikelyBase64('hello-world'), false);
    });
  });

  describe('hexTextToSafeBase64', () => {
    it('converts raw hex text and toHexPreview formats', () => {
      assert.equal(hexTextToSafeBase64('4d534244'), uint8ArrayToBase64(new Uint8Array([0x4d, 0x53, 0x42, 0x44])));
      const dump = '00000000  4d 53 42 44  |MSBD|';
      assert.equal(hexTextToSafeBase64(dump), uint8ArrayToBase64(new Uint8Array([0x4d, 0x53, 0x42, 0x44])));
    });
  });
});
