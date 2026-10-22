import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeSettings } from './ThemeSettings.js';
import { presetForMode } from './themeConfig.js';

test('theme settings show both named modes and every calibrated color control in a collapsed details section', () => {
  for (const mode of ['opal', 'obsidian'] as const) {
    const manifest = presetForMode(mode);
    const html = renderToStaticMarkup(<ThemeSettings manifest={manifest} onModeChange={() => {}}
      onIntensityChange={() => {}} onReset={() => {}} />);
    assert.match(html, /流光溢彩白/);
    assert.match(html, /五彩斑斓黑/);
    assert.match(html, new RegExp(`value="${mode}" selected=""`));
    assert.match(html, /<details class="theme-parameters"><summary>主题参数<\/summary>/);
    assert.equal((html.match(/type="range"/g) ?? []).length, 7);
    for (const color of manifest.colors) assert.ok(html.includes(`${color.label}强度`));
    assert.match(html, /恢复预设/);
    assert.match(html, /导出 JSON/);
    assert.match(html, /复制参数/);
    assert.doesNotMatch(html, /rgba\(|linear-gradient|radial-gradient/);
  }
});
