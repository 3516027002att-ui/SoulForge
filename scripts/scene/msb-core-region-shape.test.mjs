import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanonicalMapDocument } from '../../packages/shared/dist/map-document.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.env.SOULFORGE_TOOLING_ROOT ?? root, 'package.json'));
const ts = require('typescript');

test('native region shape discriminants survive the Bridge mapper into the canonical map document', async () => {
  // Sekiro's native values include the gaps for Circle and Rect. Substituting
  // sequential application IDs, or losing the field, changes the region shape.
  const shapeTypes = [0, 2, 3, 5, 6, undefined];
  const capture = {
    parseStatus: 'partial', diagnostics: [],
    data: {
      sourceHash: 'fixture-source', version: 1, modelCount: 0, partCount: 0,
      regionCount: shapeTypes.length, eventCount: 0, routeCount: 0,
      regions: shapeTypes.map((shapeType, index) => ({
        name: `region-${index}`, offset: 0x100 + index * 0x80, typeId: 15,
        ...(shapeType === undefined ? {} : { shapeType }),
        posX: index, posY: 0, posZ: 0
      }))
    }
  };
  const text = await readFile(resolve(root, 'packages/core/src/editing/msbBridgeRead.ts'), 'utf8');
  const javascript = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const source = ts.createSourceFile('msbBridgeRead.js', javascript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = source.statements.find((value) => ts.isFunctionDeclaration(value) && value.name?.text === 'readMsbDocumentViaBridge');
  assert.ok(node, 'the real production mapper must be available');
  const declaration = javascript.slice(node.getStart(source), node.end).replace(/^export /, '');
  // Only the external native read is replaced; mapper code is an unchanged
  // declaration from production, with no test-only branch in the product.
  const read = new Function('runBridge', `${declaration}\nreturn readMsbDocumentViaBridge;`)(async () => capture);
  const result = await read({ sourcePath: '/fixture/m13_00_00_00.msb', allowedRoots: ['/fixture'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.regions.map((region) => region.shapeType), shapeTypes);
  assert.equal(Object.hasOwn(result.data.regions.at(-1), 'shapeType'), false, 'legacy absent fields stay absent');
  const document = buildCanonicalMapDocument({
    ...result.data, sourceUri: 'file://map/m13_00_00_00.msb',
    sourcePath: 'map/mapstudio/m13_00_00_00.msb', game: 'sekiro', revision: 'fixture-source'
  });
  assert.deepEqual(document.regions.map((region) => region.shapeType), [0, 2, 3, 5, 6, 0]);
});
