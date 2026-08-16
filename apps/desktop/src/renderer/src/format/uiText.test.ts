/**
 * 预览截断文案的单元测试。
 *
 * 覆盖的缺陷：原文案是「预览只读取文件前缀，确保大型 DCX/BND 等二进制文件也能
 * 安全打开」——它解释了**为什么**截断，却没回答**截断到什么程度**。用户看不到
 * 数字就无法判断自己看到的是全部的一半还是万分之一，而 anti-ai-design 的状态
 * 优先原则要求界面能回答「已解析多少」。
 *
 * 断言按边界组织：真正会出错的是百分比在极小/极大值上的表现（0.02% 被 toFixed(0)
 * 压成 "0%" 会让用户以为什么都没读到）与 fileSize 缺失时的降级措辞。只测
 * 「正常情况有数字」的话，把百分比写成恒 0 也能全绿。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, formatFilesCount } from './uiText.js';

describe('formatBytes', () => {
  it('小于 1 KiB 用字节', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  it('整数 KiB/MiB 不带小数（避免 1.0 MiB 这种噪声）', () => {
    assert.equal(formatBytes(1024), '1 KiB');
    assert.equal(formatBytes(64 * 1024), '64 KiB');
    assert.equal(formatBytes(1024 * 1024), '1 MiB');
  });

  it('非整数保留一位小数', () => {
    assert.equal(formatBytes(1536), '1.5 KiB');
  });

  it('非法输入不得产出 NaN 文案', () => {
    assert.equal(formatBytes(Number.NaN), '未知');
    assert.equal(formatBytes(-1), '未知');
  });
});

describe('formatFilesCount（§3.3：数量只在 Files 物理浏览内显示且带语义单位）', () => {
  it('返回带单位的文案', () => {
    assert.equal(formatFilesCount(36), '文件 36 个');
    assert.equal(formatFilesCount(0), '文件 0 个');
  });
});
