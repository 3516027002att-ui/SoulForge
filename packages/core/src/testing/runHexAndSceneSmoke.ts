import { HexDocument } from '../editing/hexDocument.js';
import { buildMsbSceneManifest, chunkSceneNodes } from '../scene/msbSceneManifest.js';

function main(): void {
  const bytes = Buffer.from('SoulForge-HEX-DOCUMENT-0123456789ABCDEF');
  const doc = new HexDocument(bytes, 16);
  if (doc.pageCount() < 2) throw new Error('expected multiple pages');
  const page0 = doc.readPage(0);
  if (page0.offset !== 0 || page0.length !== 16) throw new Error('page0 layout');
  const old = bytes.subarray(0, 4);
  const patched = doc.applyPatch({
    offset: 0,
    oldBytesBase64: Buffer.from(old).toString('base64'),
    newBytesBase64: Buffer.from('TEST').toString('base64')
  });
  if (!patched.ok) throw new Error(JSON.stringify(patched));
  if (doc.snapshot().subarray(0, 4).toString('ascii') !== 'TEST') throw new Error('patch not applied');
  const stale = doc.applyPatch({
    offset: 0,
    oldBytesBase64: Buffer.from(old).toString('base64'),
    newBytesBase64: Buffer.from('FAIL').toString('base64')
  });
  if (stale.ok || stale.code !== 'HEX_PATCH_STALE') throw new Error('stale patch must fail');

  // search / jump / diff (backend only)
  const jump = doc.jumpTo(20);
  if (!jump.ok || jump.pageIndex !== 1) throw new Error('jumpTo page');
  const badJump = doc.jumpTo(10_000);
  if (badJump.ok) throw new Error('jump out of range must fail');
  const hits = doc.findAscii('DOCUMENT', { maxHits: 4 });
  if (hits.hits.length !== 1 || hits.hits[0]?.offset !== 14) throw new Error('findAscii hit');
  const bytesHits = doc.findBytes(Buffer.from('TEST'));
  if (bytesHits.hits.length !== 1 || bytesHits.hits[0]?.offset !== 0) throw new Error('findBytes hit');
  const other = new HexDocument(Buffer.from('SoulForge-HEX-DOCUMENT-0123456789ABCDEF'), 16);
  const diff = doc.diffAgainst(other.snapshot(), { maxSpans: 8 });
  if (diff.equal || diff.spans.length === 0) throw new Error('diff should detect patch');
  if (diff.spans[0]?.offset !== 0 || diff.spans[0]?.length !== 4) throw new Error('diff span');


  const manifest = buildMsbSceneManifest({
    mapResourceUri: 'file://map/m10_00_00_00.msb',
    parts: [
      { name: 'm000010_1077', posX: 1, posY: 2, posZ: 3, rotX: 10, scaleX: 1, scaleY: 1, scaleZ: 1 },
      { name: 'm000010_1143', posX: 4, posY: 5, posZ: 6 }
    ],
    chunkSize: 1
  });
  if (manifest.nodeCount !== 2) throw new Error('node count');
  if (manifest.nodes.some((n) => n.sourceResourceUri.includes('\\') && n.sourceResourceUri.includes(':'))) {
    throw new Error('path leak');
  }
  const chunk0 = chunkSceneNodes(manifest, 0);
  if (chunk0.length !== 1 || chunk0[0]?.label !== 'm000010_1077') throw new Error('chunk0');

  let rejected = false;
  try {
    buildMsbSceneManifest({
      mapResourceUri: 'file://map/x.msb',
      parts: [{ name: 'C:\\evil\\path', posX: 0, posY: 0, posZ: 0 }]
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'SCENE_ABSOLUTE_PATH_LEAK';
  }
  if (!rejected) throw new Error('absolute path label must be rejected');

  console.log(JSON.stringify({
    ok: true,
    message: 'Hex 文档分页/search/jump/diff 与 MSB 场景清单验证通过',
    hexPages: doc.pageCount(),
    hexHash: doc.contentHash,
    hexSearchHits: hits.hits.length,
    hexDiffSpans: diff.spans.length,
    sceneNodes: manifest.nodeCount,
    chunk0: chunk0[0]?.id
  }, null, 2));
}

main();
