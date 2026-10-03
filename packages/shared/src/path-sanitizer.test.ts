/**
 * S13：maskPathFragments 只打码路径片段（preload 与 main 共用同一规则）。
 *
 * 断言点：
 *  1. 片段替换：`写入失败：D:\x 被占用` → `写入失败：[本机路径已隐藏] 被占用`，
 *     上下文（中文全角冒号前缀）保留；
 *  2. 覆盖形态：盘符绝对路径 / UNC / 设备路径 / 盘符 file URI；
 *  3. 不打码：工作区相对 URI（file:///workspace/…）、无路径的普通文本；
 *  4. 中文路径整段打码：D:\游戏\mods\a.fmg（路径内汉字不是终止符）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskPathFragments, MASKED_PATH_PLACEHOLDER } from './path-sanitizer.js';

it('masks POSIX paths and physical file URLs while preserving surrounding text', () => {
  for (const value of ['/home/user/mod/file', '/tmp/soulforge/a.fmg', '/workspace/relative/file', 'file:///home/user/a.fmg', 'file://localhost/home/user/a.fmg', 'file://D:/Users/user/a.fmg']) {
    assert.equal(maskPathFragments(value), MASKED_PATH_PLACEHOLDER);
  }
  assert.equal(maskPathFragments('读取失败：/tmp/游戏/a.fmg（拒绝）'), `读取失败：${MASKED_PATH_PLACEHOLDER}（拒绝）`);
  assert.equal(maskPathFragments('path "/home/user/a.fmg" failed'), `path "${MASKED_PATH_PLACEHOLDER}" failed`);
  assert.equal(maskPathFragments('file:///workspace/../home/user/a.fmg'), MASKED_PATH_PLACEHOLDER);
  assert.equal(maskPathFragments('file:///workspace/%2e%2e/home/user/a.fmg'), MASKED_PATH_PLACEHOLDER);
});

it('preserves logical resource addresses and relative paths', () => {
  for (const value of ['file://chr/c0000.anibnd.dcx', 'file:///workspace/a.fmg', 'resource://owned/map', 'https://example.com/docs/a', 'chr/c0000.anibnd.dcx', './relative/a.fmg']) {
    assert.equal(maskPathFragments(value), value);
  }
});

describe('maskPathFragments（S13 片段打码）', () => {
  it('只打码路径片段，保留上下文（全角冒号前缀）', () => {
    assert.equal(
      maskPathFragments('写入失败：D:\\workspace\\mod\\a.fmg 被占用'),
      `写入失败：${MASKED_PATH_PLACEHOLDER} 被占用`
    );
  });

  it('UNC 与设备路径打码', () => {
    assert.equal(
      maskPathFragments('占用（\\\\?\\UNC\\host\\share\\b.fmg）'),
      `占用（${MASKED_PATH_PLACEHOLDER}）`
    );
    assert.equal(
      maskPathFragments('\\\\.\\device\\volume\\x'),
      MASKED_PATH_PLACEHOLDER
    );
  });

  it('盘符 file URI 打码', () => {
    assert.equal(
      maskPathFragments('来源 file:///D:/game/msg/item.fmg 未索引'),
      `来源 ${MASKED_PATH_PLACEHOLDER} 未索引`
    );
  });

  it('中文路径整段打码（路径内汉字不是终止符）', () => {
    assert.equal(
      maskPathFragments('目标 D:\\游戏\\mods\\a.fmg。请重试'),
      `目标 ${MASKED_PATH_PLACEHOLDER}。请重试`
    );
  });

  it('工作区相对 URI 不打码（逻辑地址，非本机路径）', () => {
    assert.equal(maskPathFragments('file:///workspace/a.fmg'), 'file:///workspace/a.fmg');
  });

  it('无路径的普通文本原样返回', () => {
    const text = '字段定义来源未授信，拒绝写入。';
    assert.equal(maskPathFragments(text), text);
  });

  it('空串与空内容安全', () => {
    assert.equal(maskPathFragments(''), '');
  });

  it('无匹配必需字符的字符串保留原值并避免正则替换工作', () => {
    const originalReplace = String.prototype.replace;
    let regexCalls = 0;
    String.prototype.replace = function (this: string, ...args: unknown[]) {
      if (args[0] instanceof RegExp) regexCalls += 1;
      return Reflect.apply(originalReplace, this, args);
    } as typeof originalReplace;
    try {
      for (const text of ['m000010', 'MapPiece', '字段说明（中文）']) {
        assert.equal(maskPathFragments(text), text);
      }
      assert.equal(regexCalls, 0);
    } finally {
      String.prototype.replace = originalReplace;
    }
  });
});
