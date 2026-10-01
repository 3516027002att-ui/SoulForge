import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyThemeMode, createThemePreferences, manifestForPreferences, presetForMode,
  readThemePreferences, resetThemeBudget, restoreThemePreferences, updateThemeIntensity
} from '../apps/desktop/src/renderer/src/theme/themeConfig.ts';

// Fixed reviewed upstream content, recovered from the acknowledged source
// tree. Normalize only checkout CRLF transport; all other content remains bound.
const presetHash = bytes => createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
const presets = {
  opal: { hash: '88909c3cf1da623797b1315099932eb7b8b0ce9fa8335a924db9b794f988c039',
    label: '流光溢彩白', ids: ['rose', 'peach', 'mint', 'cyan', 'blue', 'lilac'] },
  obsidian: { hash: '7c619146acbf236c33742e34689c4ab89788f2638b1ee36384f754595a78512c',
    label: '五彩斑斓黑', ids: ['teal', 'petrol', 'navy', 'indigo', 'violet', 'gold'] }
};

for (const [mode, expected] of Object.entries(presets)) {
  test(`${mode} preserves reviewed six-color content across checkout line endings and independent copies`, async () => {
    const bytes = await readFile(new URL(`../apps/desktop/src/renderer/src/theme/presets/${mode}.json`, import.meta.url));
    assert.equal(presetHash(bytes), expected.hash);
    const lf = bytes.toString('utf8').replaceAll('\r\n', '\n');
    assert.equal(presetHash(Buffer.from(lf.replaceAll('\n', '\r\n'))), expected.hash);
    assert.notEqual(presetHash(Buffer.from(lf.replace(expected.label, 'changed preset'))), expected.hash);
    assert.notEqual(presetHash(Buffer.from(lf.replace('\n', '\r'))), expected.hash, 'lone CR is not checkout transport');
    const original = JSON.parse(bytes);
    const copy = presetForMode(mode);
    assert.deepEqual(copy, original);
    assert.equal(copy.label, expected.label);
    assert.deepEqual(copy.colors.map(color => color.id), expected.ids);
    assert.equal(copy.output.reducedMotion, 'frozen-calibrated-frame');
    copy.colors[0].phase[0] = -1;
    copy.colors[0].intensity = 0;
    assert.deepEqual(presetForMode(mode), original);
  });
}

test('mode budgets round-trip independently and selected-mode reset preserves the other mode', () => {
  let preferences = createThemePreferences();
  const untouched = structuredClone(preferences);
  preferences = updateThemeIntensity(preferences, 'opal', 'rose', 0);
  preferences = updateThemeIntensity(preferences, 'obsidian', 'overall', 0.25);
  preferences.mode = 'obsidian';
  assert.deepEqual(restoreThemePreferences(JSON.stringify(preferences)), preferences);
  assert.equal(manifestForPreferences(preferences).overallColorIntensity, 0.25);
  const reset = resetThemeBudget(preferences);
  assert.deepEqual(reset.budgets.obsidian, untouched.budgets.obsidian);
  assert.equal(reset.budgets.opal.colors.rose, 0);
  assert.equal(preferences.budgets.obsidian.overall, 0.25, 'reset must not mutate its input');
});

test('invalid persisted values cannot replace finite bounded preset intensities', () => {
  const defaults = createThemePreferences();
  for (const serialized of [null, '', '{', 'null', '[]', '{"version":2}', '{"version":1,"mode":"unknown"}']) {
    assert.deepEqual(restoreThemePreferences(serialized), defaults);
  }
  const saved = { ...defaults, mode: 'obsidian', budgets: {
    opal: { overall: -1, colors: { rose: 2, peach: '0.5', mint: null, unknown: 1 } },
    obsidian: { overall: 0, colors: { teal: 0, petrol: 1 } }
  } };
  const restored = restoreThemePreferences(JSON.stringify(saved));
  assert.deepEqual(restored.budgets.opal, defaults.budgets.opal);
  assert.equal(restored.budgets.obsidian.overall, 0);
  assert.equal(restored.budgets.obsidian.colors.teal, 0);
  assert.equal(restored.budgets.obsidian.colors.petrol, 1);
  for (const value of [-1, 2, NaN, Infinity, '0.5']) {
    assert.equal(updateThemeIntensity(defaults, 'opal', 'rose', value), defaults);
  }
  assert.equal(updateThemeIntensity(defaults, 'opal', 'unknown', 0.5), defaults);
});

test('a derived manifest can be edited without changing saved preferences or the upstream palette', () => {
  const preferences = createThemePreferences();
  const before = structuredClone(preferences);
  const manifest = manifestForPreferences(preferences);
  manifest.colors[0].phase[0] = 999;
  manifest.colors[0].intensity = 1;
  assert.deepEqual(preferences, before);
  assert.notEqual(presetForMode('opal').colors[0].phase[0], 999);
});

test('denied storage reads recover defaults and both modes set their actual document datasets', () => {
  const previous = new Map(['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    globalThis.window = { localStorage: { getItem() { throw new Error('storage denied'); } } };
    globalThis.document = { documentElement: { dataset: {} } };
    assert.deepEqual(readThemePreferences(), createThemePreferences());
    applyThemeMode('obsidian');
    assert.deepEqual(document.documentElement.dataset, { theme: 'dark', spectralMode: 'obsidian' });
    applyThemeMode('opal');
    assert.deepEqual(document.documentElement.dataset, { theme: 'light', spectralMode: 'opal' });
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
