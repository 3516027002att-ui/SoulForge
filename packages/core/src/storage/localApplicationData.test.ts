import assert from 'node:assert/strict';
import test from 'node:test';
const path = './localApplicationData.js';
const storage = await import(path).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('Linux uses absolute XDG data home and ignores Windows app data', () => {
  assert.equal(typeof storage.localApplicationDataDirectory, 'function');
  assert.equal(storage.localApplicationDataDirectory({ platform: 'linux', home: '/home/test', env: { XDG_DATA_HOME: '/data/profile', LOCALAPPDATA: 'C:\\Windows-data' } }), '/data/profile');
});

test('Linux default is home-local share; empty or relative XDG values are ignored', () => {
  assert.equal(typeof storage.localApplicationDataDirectory, 'function');
  for (const XDG_DATA_HOME of [undefined, '', 'relative/path']) {
    assert.equal(storage.localApplicationDataDirectory({ platform: 'linux', home: '/home/test', env: { XDG_DATA_HOME, XDG_STATE_HOME: '/state/profile', LOCALAPPDATA: '/windows-data' } }), '/home/test/.local/share');
  }
});

test('Windows keeps LOCALAPPDATA and its legacy home fallback, regardless of XDG', () => {
  assert.equal(typeof storage.localApplicationDataDirectory, 'function');
  assert.equal(storage.localApplicationDataDirectory({ platform: 'win32', home: 'C:\\Users\\test', env: { LOCALAPPDATA: 'D:\\AppData', XDG_DATA_HOME: '/linux-data' } }), 'D:\\AppData');
  assert.equal(storage.localApplicationDataDirectory({ platform: 'win32', home: 'C:\\Users\\test', env: {} }), 'C:\\Users\\test\\AppData\\Local');
});

test('macOS keeps its Application Support convention', () => {
  assert.equal(typeof storage.localApplicationDataDirectory, 'function');
  assert.equal(storage.localApplicationDataDirectory({ platform: 'darwin', home: '/Users/test', env: {} }), '/Users/test/Library/Application Support');
});
