import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LiquidTabGroup,
  LiquidTabItem,
  LiquidPressable,
  LiquidActionGroup
} from './index.js';

describe('SoulForge Motion Wrapper Components', () => {
  it('LiquidTabGroup: 能够正常渲染前景 Tab 内容，并保持 role 与 aria 属性', () => {
    const html = renderToStaticMarkup(
      <LiquidTabGroup
        activeId="param"
        role="tablist"
        aria-label="测试导航"
        data-testid="test-domain-bar"
      >
        <LiquidTabItem id="param" as="button" role="tab" aria-selected={true}>
          <span>PARAM</span>
        </LiquidTabItem>
        <LiquidTabItem id="map" as="button" role="tab" aria-selected={false}>
          <span>MAP</span>
        </LiquidTabItem>
      </LiquidTabGroup>
    );

    assert.match(html, /role="tablist"/);
    assert.match(html, /data-testid="test-domain-bar"/);
    assert.match(html, /aria-label="测试导航"/);
    assert.match(html, /data-tab-id="param"/);
    assert.match(html, /data-tab-id="map"/);
    assert.match(html, /is-selected/);
    assert.match(html, /PARAM/);
    assert.match(html, /MAP/);
  });

  it('LiquidPressable: 能够透传所有原生属性并渲染 children', () => {
    const html = renderToStaticMarkup(
      <LiquidPressable
        type="button"
        aria-label="发送消息"
        data-testid="send-btn"
        className="btn btn--primary"
      >
        <span>发送</span>
      </LiquidPressable>
    );

    assert.match(html, /data-testid="send-btn"/);
    assert.match(html, /aria-label="发送消息"/);
    assert.match(html, /class="liquid-pressable\s+btn btn--primary"/);
    assert.match(html, /<span>发送<\/span>/);
  });

  it('LiquidActionGroup: 支持展开与折叠模式渲染', () => {
    const closedHtml = renderToStaticMarkup(
      <LiquidActionGroup open={false}>
        <button type="button">Action 1</button>
        <button type="button">Action 2</button>
      </LiquidActionGroup>
    );
    assert.match(closedHtml, /is-closed/);

    const openHtml = renderToStaticMarkup(
      <LiquidActionGroup open={true}>
        <button type="button">Action 1</button>
        <button type="button">Action 2</button>
      </LiquidActionGroup>
    );
    assert.match(openHtml, /is-open/);
    assert.match(openHtml, /Action 1/);
    assert.match(openHtml, /Action 2/);
  });
});
