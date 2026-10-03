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
import { KNOWN_RESOURCE_DIRS } from './types.js';

it('masks network file authorities, including dotted hosts, ports and encoded hosts', () => {
  for (const value of [
    'file://prod-server/share/mod/a.fmg',
    'FILE://prod-server.example/share/mod/a.fmg',
    'file://prod-server.fmg/share/mod/a.fmg',
    'file://prod-server.bnd/share/mod/a.fmg',
    'file://192.168.0.23/share/mod/a.fmg',
    'file://[2001:db8::1]/share/mod/a.fmg',
    'file://prod-server:445/share/mod/a.fmg',
    'file://user@prod-server/share/mod/a.fmg',
    'file://%70rod-server/share/mod/a.fmg',
    'file://%63hr/share/mod/a.fmg',
    'file://%31%32%37.0.0.1/share/mod/a.fmg',
    'file://prod-server.fmg%2fshare',
    'file://prod-server.fmg%252fshare',
    'file://custom/share/mod/a.fmg'
  ]) {
    assert.equal(maskPathFragments(value), MASKED_PATH_PLACEHOLDER, value);
    assert.equal(maskPathFragments(`Read failed: ${value} (retry later)`),
      `Read failed: ${MASKED_PATH_PLACEHOLDER} (retry later)`, value);
  }
});

it('preserves actual project directory authorities, root files and container selectors', () => {
  for (const directory of KNOWN_RESOURCE_DIRS) {
    const uri = `file://${directory}/logical-resource.fmg`;
    assert.equal(maskPathFragments(uri), uri);
  }
  for (const uri of [
    'file://unknown', 'file://resource',
    'file://regulation.bin', 'file://bytecode.hks', 'file://a.fmg',
    'file://notes.txt', 'file://pack.bnd#bnd/child/item.fmg',
    'file://regulation.bin!/EquipParam.param',
    'file://chr/c0000.anibnd.dcx!/c0000.tae',
    'file://msg/ja%20JP/item.msgbnd.dcx#bnd/child/item.fmg',
    'FILE://CHR/c0000.anibnd.dcx', 'file:///workspace/a.fmg'
  ]) assert.equal(maskPathFragments(uri), uri, uri);
});

it('logical authority does not permit encoded path escapes or physical separators', () => {
  for (const uri of [
    'file://chr/../private/a.fmg',
    'file://map/%2e%2e/private/a.fmg',
    'file://param/%252e%252e/private/a.fmg',
    'file://chr/c0000%5canibnd.dcx',
    'file://chr%2fprod-server/share/mod/a.fmg',
    'file://resource/share/mod/a.fmg',
    'file://unknown/share/mod/a.fmg'
  ]) assert.equal(maskPathFragments(uri), MASKED_PATH_PLACEHOLDER, uri);
});

it('logical namespaces cannot carry absolute paths in their decoded URI suffix', () => {
  for (const uri of [
    'file://chr/C:/Users/alice/secret.flver',
    'file://chr//home/alice/secret.flver',
    'file://chr/C%3A%2FUsers%2Falice%2Fsecret.flver',
    'file://chr/C%253A%252FUsers%252Falice%252Fsecret.flver',
    'file://chr/%2Fhome%2Falice%2Fsecret.flver',
    'file://chr/%252Fhome%252Falice%252Fsecret.flver',
    'FILE://CHR/c%253a%252fUsers%252falice%252fsecret.flver',
    'file://map/models/C:/Users/alice/secret.flver',
    'file://param/nested//home/alice/secret.param',
    'file:///workspace/C:/Users/alice/secret.flver',
    'file:///workspace/%252Fhome%252Falice%252Fsecret.flver'
  ]) {
    assert.equal(maskPathFragments(uri), MASKED_PATH_PLACEHOLDER, uri);
    assert.equal(maskPathFragments(`Read failed: ${uri} (retry later)`),
      `Read failed: ${MASKED_PATH_PLACEHOLDER} (retry later)`, uri);
  }
});

it('logical file URI query and fragment cannot carry embedded physical paths', () => {
  for (const uri of [
    'file://regulation.bin?path=C:/private/demo.fmg',
    'file://chr/foo.flver#source=/home/private/demo.fmg',
    'file:///workspace/a.fmg?source=/home/private/demo.fmg',
    'file://pack.bnd#bnd/child/C:/private/demo.fmg',
    'file://pack.bnd?path=C%3A%2Fprivate%2Fdemo.fmg',
    'file://pack.bnd?path=C%253A%252Fprivate%252Fdemo.fmg',
    'file://chr/foo.flver#source=%2Fhome%2Fprivate%2Fdemo.fmg',
    'file://chr/foo.flver#source=%252Fhome%252Fprivate%252Fdemo.fmg',
    'file://chr/foo.flver%23source%3D%252Fhome%252Fprivate%252Fdemo.fmg',
    'file://regulation.bin?source=file%3A%2F%2F%2Fhome%2Fprivate%2Fdemo.fmg',
    'file://chr/foo.flver#source=file%253A%252F%252Fprod-server%252Fprivate%252Fdemo.fmg',
    'file://pack.bnd#bnd/child/%2Fhome/private/demo.fmg',
    'file://pack.bnd!/%252Fhome/private/demo.fmg'
  ]) {
    assert.equal(maskPathFragments(uri), MASKED_PATH_PLACEHOLDER, uri);
    assert.equal(maskPathFragments(`Read failed: ${uri} (retry later)`),
      `Read failed: ${MASKED_PATH_PLACEHOLDER} (retry later)`, uri);
  }
});

it('relative query labels and encoded container selectors keep their logical identity', () => {
  for (const uri of [
    'file://regulation.bin?version=1',
    'file://chr/foo.flver#source=chr/relative.flver',
    'file://pack.bnd#bnd/entry',
    'file://pack.bnd#bnd/child/dir%2Fentry.fmg',
    'file://pack.bnd#bnd/child/dir%252Fentry.fmg',
    'file://pack.bnd!/dir%2Fentry.fmg',
    'file://chr/pack.bnd!/dir%252Fentry.fmg',
    'file://chr/c0000/models/c0000.flver',
    'file://chr/c0000.anibnd.dcx!/animations/c0000.tae',
    'file://map/mapstudio/m10_00_00_00.msb.dcx?variant=base',
    'file:///workspace/chr/c0000.flver?version=2#bnd/entry'
  ]) assert.equal(maskPathFragments(uri), uri, uri);
});

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
