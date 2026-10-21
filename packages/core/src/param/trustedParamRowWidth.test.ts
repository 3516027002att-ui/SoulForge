import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadFirstPartyParamMetadata } from '../schema/sekiro/firstPartySchema.js';
import { resolveTrustedParamRowWidth } from './containerParamEdit.js';

// The editor and compare/run.mjs (param/read-rows) take single-row PARAM widths from resolveTrustedParamRowWidth.
// This checks the lookup: every first-party definition resolves to its own recorded width through the editor's
// descriptor. Whether those widths fit the real files is shown by the comparison against the reference tool.
function firstPartyKeys() {
  const loaded = loadFirstPartyParamMetadata();
  if (!loaded.ok) throw new Error(`first-party PARAM metadata did not load: ${JSON.stringify(loaded.diagnostics)}`);
  assert.ok(loaded.package.definitions.length > 0);
  return loaded.package.definitions.map(definition => definition.key);
}

it('every first-party PARAM definition resolves to its recorded row width', async () => {
  for (const key of firstPartyKeys()) {
    assert.equal(await resolveTrustedParamRowWidth({ typeName: key.typeName, dataVersion: key.dataVersion }, key.game),
      key.rowDataSize, `${key.typeName}@${key.dataVersion}`);
  }
});

it('an unknown type, version or game has no width', async () => {
  const [key] = firstPartyKeys();
  assert.equal(await resolveTrustedParamRowWidth({ typeName: 'NOT_A_PARAM_ST', dataVersion: key!.dataVersion }, key!.game), undefined);
  assert.equal(await resolveTrustedParamRowWidth({ typeName: key!.typeName, dataVersion: key!.dataVersion + 1000 }, key!.game), undefined);
  assert.equal(await resolveTrustedParamRowWidth({ typeName: key!.typeName, dataVersion: key!.dataVersion }, 'not-a-game'), undefined);
});
