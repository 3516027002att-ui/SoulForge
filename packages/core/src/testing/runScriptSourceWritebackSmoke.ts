/**
 * S34：脚本写回编码必须跟打开时一致。
 * 合成 fixture，不写真实 Mod / 游戏目录。
 */
import { encodeScriptSourceForWriteback } from '../script/scriptSourceWriteback.js';
import { classifyPlaintextBytes, decodePlaintext } from '../script/plaintextScriptEntry.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function buildShiftJisSample(): Uint8Array {
  const japaneseComment = [0x23, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a];
  const asciiBody = new TextEncoder().encode(
    `Num = 1\n${Array.from({ length: 120 }, (_, index) => `${index} = "a${index}"`).join('\n')}\n`
  );
  const out = new Uint8Array(japaneseComment.length + asciiBody.length);
  out.set(japaneseComment, 0);
  out.set(asciiBody, japaneseComment.length);
  return out;
}

function buildMixedSample(): Uint8Array {
  // 真实 801000_battle.lua 的 GBK「左手」(D7 F3 CA D6) 在 ICU 里仍能当
  // Shift-JIS 解开（0xD7 是半角片假名），fatal decoder 不抛，会被误判成
  // shift_jis。这里用非法 SJIS 引导字节 0x80/0xFD，UTF-8 与 Shift-JIS
  // 都会 fatal 失败，才是 mixed-unknown。前面垫足够 ASCII，可打印比 > 0.99。
  const head = new TextEncoder().encode(
    `act[26] = 100\n${Array.from({ length: 200 }, (_, index) => `${index} = "a${index}"`).join('\n')}\n`
  );
  const invalid = Uint8Array.from([0x80, 0xfd, 0x0a]);
  const tail = new TextEncoder().encode('other = 7\n');
  const out = new Uint8Array(head.length + invalid.length + tail.length);
  out.set(head, 0);
  out.set(invalid, head.length);
  out.set(tail, head.length + invalid.length);
  return out;
}

export function runScriptSourceWritebackSmoke(): { ok: boolean; message: string; passed: number; total: number } {
  let passed = 0;
  const total = 4;

  {
    const original = buildShiftJisSample();
    const text = decodePlaintext(original, 'shift_jis').replace('Num = 1', 'Num = 9');
    const encoded = encodeScriptSourceForWriteback(original, text);
    assert(encoded.ok, `SJIS 写回应成功：${encoded.ok ? '' : encoded.message}`);
    if (encoded.ok) {
      assert(encoded.encoding === 'shift_jis', `应为 shift_jis，实际 ${encoded.encoding}`);
      assert(encoded.writeKind === 'plaintext', `writeKind 应为 plaintext，实际 ${encoded.writeKind}`);
      const again = decodePlaintext(encoded.bytes, 'shift_jis');
      assert(again.includes('Num = 9'), 'SJIS 写回后必须仍能按 Shift-JIS 读出日文和改动');
      assert(again.includes('日本語') || again.includes('\u65e5\u672c\u8a9e') || encoded.bytes[1] === 0x93, '日文首字节必须还在');
    }
    passed += 1;
  }

  {
    const original = buildMixedSample();
    assert(classifyPlaintextBytes(original).detectedEncoding === 'mixed-unknown', '混合样本应判 mixed-unknown');
    const display = decodePlaintext(original, 'mixed-unknown');
    const edited = display.replace('act[26] = 100', 'act[26] = 101');
    const encoded = encodeScriptSourceForWriteback(original, edited);
    assert(encoded.ok, `混合编码 ASCII 行写回应成功：${encoded.ok ? '' : encoded.message}`);
    if (encoded.ok) {
      assert(encoded.writeKind === 'mixed-ascii', `writeKind 应为 mixed-ascii，实际 ${encoded.writeKind}`);
      const highBefore = [...original].filter((b) => b >= 0x80);
      const highAfter = [...encoded.bytes].filter((b) => b >= 0x80);
      assert(highBefore.length === highAfter.length && highBefore.every((b, i) => b === highAfter[i]), '非 ASCII 字节必须原样');
      assert(Buffer.from(encoded.bytes).toString('latin1').includes('act[26] = 101'), 'ASCII 改动必须落盘');
    }
    passed += 1;
  }

  {
    const original = buildMixedSample();
    const display = decodePlaintext(original, 'mixed-unknown');
    const smashed = `${display}\nextra`;
    const encoded = encodeScriptSourceForWriteback(original, smashed);
    assert(!encoded.ok, '混合编码增行必须失败');
    if (!encoded.ok) assert(encoded.code === 'SCRIPT_MIXED_LINE_COUNT_CHANGED', `码应为 SCRIPT_MIXED_LINE_COUNT_CHANGED，实际 ${encoded.code}`);
    passed += 1;
  }

  {
    const bytecode = Uint8Array.from([0x1b, 0x4c, 0x75, 0x61, 0x51, 0x00, 0x01]);
    const encoded = encodeScriptSourceForWriteback(bytecode, 'print("ok")\n');
    assert(encoded.ok, '反编译文本写回应成功，不要因缺编译器拒写');
    if (encoded.ok) {
      assert(encoded.writeKind === 'decompiled-as-utf8', `writeKind 应为 decompiled-as-utf8，实际 ${encoded.writeKind}`);
      assert(Buffer.from(encoded.bytes).toString('utf8') === 'print("ok")\n', '字节码槽写回必须是 UTF-8 明文');
    }
    passed += 1;
  }

  return {
    ok: passed === total,
    message: `script source writeback ${passed}/${total}`,
    passed,
    total
  };
}

if (process.argv[1] && process.argv[1].endsWith('runScriptSourceWritebackSmoke.js')) {
  try {
    const result = runScriptSourceWritebackSmoke();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (error: unknown) {
    console.error(JSON.stringify({
      ok: false,
      code: 'SCRIPT_SOURCE_WRITEBACK_SMOKE_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exit(1);
  }
}
