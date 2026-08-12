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
import { formatBytes, formatFilesCount, formatPreviewTruncation } from './uiText.js';

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

describe('formatPreviewTruncation', () => {
  it('必须同时报出已读量与总量——只报其中一个用户无法判断规模', () => {
    const text = formatPreviewTruncation(64 * 1024, 8 * 1024 * 1024);
    assert.ok(text.includes('64 KiB'), `缺已读量: ${text}`);
    assert.ok(text.includes('8 MiB'), `缺总量: ${text}`);
  });

  it('极小占比不得被压成 0%（那会读成「什么都没读到」）', () => {
    // 64 KiB / 1 GiB ≈ 0.006%
    const text = formatPreviewTruncation(64 * 1024, 1024 * 1024 * 1024);
    assert.ok(text.includes('<0.1'), `极小占比应显示 <0.1 而非 0：${text}`);
    assert.ok(!/（0%）/.test(text), `不得出现 0%：${text}`);
  });

  it('中等占比保留一位小数', () => {
    // 64 KiB / 10 MiB ≈ 0.625%
    const text = formatPreviewTruncation(64 * 1024, 10 * 1024 * 1024);
    assert.ok(/0\.6%/.test(text), `应保留一位小数：${text}`);
  });

  it('大占比取整（10% 以上不需要小数）', () => {
    const text = formatPreviewTruncation(50 * 1024, 100 * 1024);
    assert.ok(/（50%）/.test(text), `应取整：${text}`);
  });

  it('fileSize 缺失时明说总量未知，不猜也不省略这个事实', () => {
    const text = formatPreviewTruncation(64 * 1024, undefined);
    assert.ok(text.includes('64 KiB'), `仍须报已读量: ${text}`);
    assert.ok(text.includes('未知'), `须明说总量未知: ${text}`);
    assert.ok(!text.includes('%'), `总量未知时不得给百分比: ${text}`);
  });

  it('fileSize 为 0 或非法时走未知分支而不是除零', () => {
    for (const bad of [0, -1, Number.NaN]) {
      const text = formatPreviewTruncation(1024, bad);
      assert.ok(text.includes('未知'), `fileSize=${bad} 应走未知分支: ${text}`);
      assert.ok(!text.includes('NaN'), `不得泄漏 NaN: ${text}`);
    }
  });

  it('文案必须说明未读部分不参与解析与编辑判定', () => {
    // 这条不是措辞洁癖：App.tsx:343 的 canEditText 用 !preview.truncated 禁止
    // 编辑截断内容，用户需要知道「看不到的部分」与「不能编辑」之间的因果。
    const text = formatPreviewTruncation(64 * 1024, 8 * 1024 * 1024);
    assert.ok(text.includes('未读'), `须说明未读部分的影响: ${text}`);
  });
});

describe('formatFilesCount（§3.3：数量只在 Files 物理浏览内显示且带语义单位）', () => {
  it('返回带单位的文案', () => {
    assert.equal(formatFilesCount(36), '文件 36 个');
    assert.equal(formatFilesCount(0), '文件 0 个');
  });
});
