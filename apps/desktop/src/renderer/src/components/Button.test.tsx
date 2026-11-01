import assert from 'node:assert/strict';
import { join } from 'node:path';
import { it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readOrderedStyleSource } from '../styleSource.testSupport.js';
import { Button, IconButton } from './Button.js';
import { buttonClass } from './buttonClass.js';

it('disabled button keeps the native attribute, shows its reason and never uses aria-disabled', () => {
  const html = renderToStaticMarkup(
    <Button variant="ghost" size="sm" icon="plus" disabled disabledReason="先在左栏选择一个参数表" title="新建一行">新建行</Button>
  );
  assert.match(html, /^<button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" disabled="" title="先在左栏选择一个参数表">/);
  assert.match(html, /<svg class="ui-icon" width="14" height="14"[^>]*aria-hidden="true"/);
  assert.match(html, />新建行<\/button>$/);
  // [aria-disabled="true"] 的全局规则会降透明度（renderer-accessibility.css），按钮不能走那条路。
  assert.doesNotMatch(html, /aria-disabled/);
  const enabled = renderToStaticMarkup(<Button disabledReason="不该出现" title="新建一行">新建行</Button>);
  assert.match(enabled, /title="新建一行"/);
  assert.doesNotMatch(enabled, /不该出现|disabled=/);
});

it('icon button takes its accessible name and tooltip from the required label', () => {
  const html = renderToStaticMarkup(<IconButton icon="x" label="关闭问题面板" size="sm" onClick={() => undefined} />);
  assert.match(html, /class="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon"/);
  assert.match(html, /aria-label="关闭问题面板"/);
  assert.match(html, /title="关闭问题面板"/);
  assert.doesNotMatch(html, /<\/svg>[^<]+<\/button>/);
  // @ts-expect-error label 是必填的：没有可见文字的按钮必须有读屏名。
  void (() => <IconButton icon="x" />);
});

it('toggle buttons expose aria-pressed and class names are shared with DOM-built buttons', () => {
  assert.match(renderToStaticMarkup(<Button pressed>全部</Button>), /aria-pressed="true"/);
  assert.doesNotMatch(renderToStaticMarkup(<Button>全部</Button>), /aria-pressed/);
  assert.equal(buttonClass(), 'ui-btn ui-btn--secondary ui-btn--md');
  assert.equal(buttonClass({ variant: 'ghost', size: 'sm', className: 'x' }), 'ui-btn ui-btn--ghost ui-btn--sm x');
});

it('disabled buttons dim only their colour: no rule that reaches a disabled .ui-btn lowers opacity', () => {
  const css = readOrderedStyleSource(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1] ?? '', m[2] ?? ''] as const);
  const reaching = rules.filter(([selector]) =>
    selector.split(',').some((part) => {
      const s = part.trim();
      return s.includes(':disabled') && (s.includes('.ui-btn') || /^(button)?:disabled$/.test(s));
    }));
  assert.ok(reaching.some(([selector, body]) => /\.ui-btn:disabled/.test(selector) && /color:\s*var\(--ink-3\)/.test(body)),
    '.ui-btn:disabled 应把字色降到 --ink-3');
  for (const [selector, body] of reaching) {
    assert.doesNotMatch(body, /opacity/, `${selector.trim()} 降了透明度`);
  }
});
