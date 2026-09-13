import test from 'node:test';
import assert from 'node:assert/strict';

import { scanIpcSource } from './inspect-baseline.mjs';

test('保留不可解析通道表达式并报告重复注册', () => {
  const files = [
    {
      relativePath: 'fixture/one.ts',
      sourceText: `
        const KNOWN = 'fixture.known';
        ipcMain.handle(KNOWN, handler);
        ipcMain.handle('fixture.known', otherHandler);
        ipcMain.handle(prefix + dynamicName, dynamicHandler);
      `
    }
  ];

  const result = scanIpcSource(files);

  assert.deepEqual(
    result.channels.map((entry) => entry.channel),
    ['fixture.known', 'fixture.known']
  );
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].channel, 'fixture.known');
  assert.equal(result.unresolvedChannels.length, 1);
  assert.match(result.unresolvedChannels[0].expression, /prefix/);
});

test('不把带插值的模板字符串猜成通道名', () => {
  const result = scanIpcSource([{
    relativePath: 'fixture/two.ts',
    sourceText: 'ipcMain.handle(`fixture.${name}`, handler);'
  }]);

  assert.equal(result.channels.length, 0);
  assert.equal(result.unresolvedChannels.length, 1);
  assert.match(result.unresolvedChannels[0].expression, /fixture/);
});

test('记录直接文件写入与后台异步入口', () => {
  const result = scanIpcSource([{
    relativePath: 'fixture/three.ts',
    sourceText: `
      import { writeFile } from 'node:fs/promises';
      void Promise.race([work(), timeout()]);
      writeFile(target, contents);
    `
  }]);

  assert.ok(result.asynchronousEntries.some(entry => entry.category === 'void-background-promise'));
  assert.ok(result.asynchronousEntries.some(entry => entry.category === 'promise-race'));
  assert.ok(result.asynchronousEntries.some(entry => entry.category === 'direct-file-write'));
});
