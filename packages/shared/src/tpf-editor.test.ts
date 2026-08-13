/**
 * TEXTURE-52A — TPF 前端 DTO 的 pages 投影契约测试。
 *
 * 覆盖：projectTpfDocumentPages 把 read-tpf-document envelope 投影成
 * texture list / summary 两页；缺失字段（无 textures）的防御路径；
 * isTpfDocument 窄守卫的接受/拒绝；tpfTextureStableId 与
 * tpfTextureIndexFromStableId 的双向与非法输入。
 * 负向优先：不是「有数据时对」，而是「缺字段时不崩且给可读默认」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectTpfDocumentPages,
  isTpfDocument,
  tpfTextureStableId,
  tpfTextureIndexFromStableId,
  type TpfDocument
} from './tpf-editor.js';

function makeEnvelope(overrides: Record<string, unknown> = {}): TpfDocument {
  return {
    format: 'TPF',
    sourceSize: 4096,
    sourceHash: 'abc123',
    textureCount: 2,
    dataLength: 4000,
    platform: 5,
    encoding: 1,
    flags: 0,
    textures: [
      {
        index: 0,
        name: 'm_a.dds',
        format: 'BC1',
        formatByte: 0x00,
        mipCount: 10,
        dataOffset: 0x110,
        dataSize: 2048,
        width: 256,
        height: 256,
        ddsFourCC: 'DX10'
      },
      {
        index: 1,
        name: 'n.dds',
        format: 'BC7',
        formatByte: 0x62,
        mipCount: 10,
        dataOffset: 0x910,
        dataSize: 2048,
        width: 512,
        height: 128,
        ddsFourCC: 'DX10'
      }
    ],
    roundTrip: {
      byteIdentical: true,
      semanticIdentical: true,
      sourceHash: 'abc123',
      rebuiltHash: 'abc123',
      textureCount: 2
    },
    rebuildCoverage: {
      uncoveredBytes: 54,
      uncoveredNonZeroBytes: 0,
      firstNonZeroOffset: -1
    },
    authority: 'native-verified',
    ...overrides
  } as TpfDocument;
}

test('projectTpfDocumentPages 投影 texture list page（保留尺寸/格式/mip/真实 fourCC）', () => {
  const pages = projectTpfDocumentPages(makeEnvelope());
  assert.equal(pages.textures.textureCount, 2);
  assert.equal(pages.textures.textures.length, 2);
  const first = pages.textures.textures[0]!;
  assert.equal(first.name, 'm_a.dds');
  assert.equal(first.width, 256);
  assert.equal(first.height, 256);
  assert.equal(first.format, 'BC1');
  assert.equal(first.mipCount, 10);
  // ddsFourCC 是 DDS 头里的真实封装形态，与条目表查表的 format 分开。
  assert.equal(first.ddsFourCC, 'DX10');
  assert.equal(pages.textures.authority, 'native-verified');
});

test('projectTpfDocumentPages 投影 summary page（容器头 + 往返 + 覆盖面）', () => {
  const pages = projectTpfDocumentPages(makeEnvelope());
  assert.equal(pages.summary.platform, 5);
  assert.equal(pages.summary.encoding, 1);
  assert.equal(pages.summary.flags, 0);
  assert.equal(pages.summary.sourceHash, 'abc123');
  assert.equal(pages.summary.roundTrip.byteIdentical, true);
  assert.equal(pages.summary.rebuildCoverage.uncoveredNonZeroBytes, 0);
  assert.equal(pages.summary.rebuildCoverage.firstNonZeroOffset, -1);
});

test('缺 textures 时 texture page 为空列表（不崩）', () => {
  const pages = projectTpfDocumentPages(makeEnvelope({ textures: undefined }));
  assert.deepEqual(pages.textures.textures, []);
  assert.equal(pages.textures.textureCount, 2);
});

test('isTpfDocument 窄守卫：接受 TPF envelope、拒绝垃圾值', () => {
  assert.equal(isTpfDocument(makeEnvelope()), true);
  assert.equal(isTpfDocument({ format: 'FLVER', sourceHash: 'x', authority: 'native-verified' }), false);
  assert.equal(isTpfDocument(null), false);
  assert.equal(isTpfDocument('TPF'), false);
});

test('tpfTextureStableId 双向一致', () => {
  assert.equal(tpfTextureStableId(0), 'texture:0');
  assert.equal(tpfTextureStableId(12), 'texture:12');
  assert.equal(tpfTextureIndexFromStableId('texture:12'), 12);
  assert.equal(tpfTextureIndexFromStableId('texture:0'), 0);
});

test('tpfTextureIndexFromStableId 拒绝非法输入（不崩）', () => {
  assert.equal(tpfTextureIndexFromStableId('texture:'), null);
  assert.equal(tpfTextureIndexFromStableId('texture:abc'), null);
  assert.equal(tpfTextureIndexFromStableId('mesh:0'), null);
  assert.equal(tpfTextureIndexFromStableId(''), null);
  assert.equal(tpfTextureIndexFromStableId(null as unknown as string), null);
});
