import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerWindowThemeIpcHandlers } from './windowTheme.js';

function receiver(platform: NodeJS.Platform, options: { missing?: boolean; destroyed?: boolean; backgroundFails?: boolean; overlayFails?: boolean } = {}) {
  const backgrounds: string[] = [];
  const overlays: unknown[] = [];
  let resolutions = 0;
  let listener: ((...args: never[]) => unknown) | undefined;
  registerWindowThemeIpcHandlers({
    handle: (channel, handler) => {
      assert.equal(channel, 'window.setThemeMode');
      listener = handler;
    },
    windowForSender: () => {
      resolutions++;
      return options.missing ? null : {
        isDestroyed: () => options.destroyed ?? false,
        setBackgroundColor: color => { if (options.backgroundFails) throw new Error('native unavailable'); backgrounds.push(color); },
        setTitleBarOverlay: value => { if (options.overlayFails) throw new Error('overlay unsupported'); overlays.push(value); }
      };
    },
    platform
  });
  assert.ok(listener);
  return { invoke: (mode: unknown) => Reflect.apply(listener!, undefined, [{}, mode]), backgrounds, overlays, resolutions: () => resolutions };
}

test('native theme modes are fixed tokens and only change the resolved sender window', async () => {
  const target = receiver('win32');
  assert.deepEqual(await target.invoke('obsidian'), { ok: true });
  assert.deepEqual(await target.invoke('opal'), { ok: true });
  assert.deepEqual(target.backgrounds, ['#010306', '#FBFBF9']);
  assert.deepEqual(target.overlays, [
    { color: '#010306', symbolColor: '#DCE7EA', height: 40 },
    { color: '#FBFBF9', symbolColor: '#383C42', height: 40 }
  ]);
});

test('invalid native theme payloads cannot resolve or mutate a window', async () => {
  const target = receiver('win32');
  for (const mode of [null, undefined, '', 'dark', '#ffffff', {}, { mode: 'obsidian', color: '#ffffff' }, ['opal'], 1]) {
    assert.deepEqual(await target.invoke(mode), { ok: false, code: 'WINDOW_THEME_MODE_INVALID' });
  }
  assert.equal(target.resolutions(), 0);
  assert.deepEqual(target.backgrounds, []);
  assert.deepEqual(target.overlays, []);
});

test('native theme cannot mutate an absent or destroyed sender window', async () => {
  for (const options of [{ missing: true }, { destroyed: true }]) {
    const target = receiver('win32', options);
    assert.deepEqual(await target.invoke('obsidian'), { ok: false, code: 'WINDOW_THEME_WINDOW_UNAVAILABLE' });
    assert.deepEqual(target.backgrounds, []);
    assert.deepEqual(target.overlays, []);
  }
});

test('Linux retains the fixed background without calling unsupported titlebar overlay', async () => {
  const target = receiver('linux', { overlayFails: true });
  assert.deepEqual(await target.invoke('obsidian'), { ok: true });
  assert.deepEqual(target.backgrounds, ['#010306']);
  assert.deepEqual(target.overlays, []);
});

test('unsupported native overlay returns an explicit failure without throwing at startup', async () => {
  const target = receiver('win32', { overlayFails: true });
  assert.deepEqual(await target.invoke('obsidian'), { ok: false, code: 'WINDOW_THEME_OVERLAY_UNAVAILABLE' });
  assert.deepEqual(target.backgrounds, ['#010306']);
});

test('macOS synchronizes the background without calling the unavailable overlay API', async () => {
  const target = receiver('darwin', { overlayFails: true });
  assert.deepEqual(await target.invoke('obsidian'), { ok: true });
  assert.deepEqual(target.backgrounds, ['#010306']);
  assert.deepEqual(target.overlays, []);
});

test('native background failure returns an explicit failure before any overlay call', async () => {
  const target = receiver('win32', { backgroundFails: true });
  assert.deepEqual(await target.invoke('obsidian'), { ok: false, code: 'WINDOW_THEME_APPLY_FAILED' });
  assert.deepEqual(target.overlays, []);
});
