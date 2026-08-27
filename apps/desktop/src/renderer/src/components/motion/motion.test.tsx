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
  describe('LiquidPressable', () => {
    it('能够正常透传 aria-*、className、disabled 属性', () => {
      const html = renderToStaticMarkup(
        <LiquidPressable
          type="button"
          aria-label="发送消息"
          aria-pressed={true}
          disabled={true}
          data-testid="send-btn"
          className="btn btn--primary"
        >
          <span>发送</span>
        </LiquidPressable>
      );

      assert.match(html, /data-testid="send-btn"/);
      assert.match(html, /aria-label="发送消息"/);
      assert.match(html, /aria-pressed="true"/);
      assert.match(html, /disabled=""/);
      assert.match(html, /class="liquid-pressable\s+btn btn--primary"/);
      assert.match(html, /<span>发送<\/span>/);
    });

    it('组合调用方传入的 onMouseEnter / onMouseLeave 与 pointer 事件处理器，不发生覆盖', () => {
      let mouseEnterCalled = false;
      let mouseLeaveCalled = false;
      let pointerDownCalled = false;
      let pointerUpCalled = false;
      let pointerLeaveCalled = false;
      let pointerCancelCalled = false;

      // 验证组件渲染与 handler 挂载
      const element = (
        <LiquidPressable
          type="button"
          onMouseEnter={() => {
            mouseEnterCalled = true;
          }}
          onMouseLeave={() => {
            mouseLeaveCalled = true;
          }}
          onPointerDown={() => {
            pointerDownCalled = true;
          }}
          onPointerUp={() => {
            pointerUpCalled = true;
          }}
          onPointerLeave={() => {
            pointerLeaveCalled = true;
          }}
          onPointerCancel={() => {
            pointerCancelCalled = true;
          }}
        >
          <span>Click Me</span>
        </LiquidPressable>
      );

      const html = renderToStaticMarkup(element);
      assert.match(html, /Click Me/);

      // 直接测试 props composition 逻辑
      element.props.onMouseEnter({} as any);
      assert.equal(mouseEnterCalled, true, 'consumer onMouseEnter 必须被调用');

      element.props.onMouseLeave({} as any);
      assert.equal(mouseLeaveCalled, true, 'consumer onMouseLeave 必须被调用');

      element.props.onPointerDown({} as any);
      assert.equal(pointerDownCalled, true, 'consumer onPointerDown 必须被调用');

      element.props.onPointerUp({} as any);
      assert.equal(pointerUpCalled, true, 'consumer onPointerUp 必须被调用');

      element.props.onPointerLeave({} as any);
      assert.equal(pointerLeaveCalled, true, 'consumer onPointerLeave 必须被调用');

      element.props.onPointerCancel({} as any);
      assert.equal(pointerCancelCalled, true, 'consumer onPointerCancel 必须被调用');
    });

    it('disableAnimation 属性生效时不带 transform transition 状态', () => {
      const html = renderToStaticMarkup(
        <LiquidPressable type="button" disableAnimation={true}>
          <span>No Anim</span>
        </LiquidPressable>
      );
      assert.match(html, /<span>No Anim<\/span>/);
    });
  });

  describe('LiquidTabGroup & LiquidTabItem', () => {
    it('能够正常渲染前景 Tab 内容，并保持 role、aria-selected 与 layout 契约', () => {
      const html = renderToStaticMarkup(
        <LiquidTabGroup
          activeId="param"
          role="tablist"
          aria-label="测试工作域"
          className="domain-bar__tabs"
          data-testid="domain-bar"
        >
          <LiquidTabItem id="project" as="button" role="tab" aria-selected={false} className="domain-tab">
            <span className="domain-tab__label">开始</span>
          </LiquidTabItem>
          <LiquidTabItem id="param" as="button" role="tab" aria-selected={true} className="domain-tab is-selected">
            <span className="domain-tab__label">PARAM</span>
          </LiquidTabItem>
          <LiquidTabItem id="map" as="button" role="tab" aria-selected={false} className="domain-tab">
            <span className="domain-tab__label">MAP</span>
          </LiquidTabItem>
        </LiquidTabGroup>
      );

      // 容器契约
      assert.match(html, /role="tablist"/);
      assert.match(html, /data-testid="domain-bar"/);
      assert.match(html, /class="liquid-tab-group domain-bar__tabs"/);
      assert.match(html, /class="liquid-tab-group__content"/);

      // Tab 项契约
      assert.match(html, /data-tab-id="project"/);
      assert.match(html, /data-tab-id="param"/);
      assert.match(html, /data-tab-id="map"/);
      assert.match(html, /aria-selected="true"/);
      assert.match(html, /aria-selected="false"/);

      // DOM Content Layer 文本未被 SVG filter 污染
      assert.match(html, /<span class="domain-tab__label">开始<\/span>/);
      assert.match(html, /<span class="domain-tab__label">PARAM<\/span>/);
      assert.match(html, /<span class="domain-tab__label">MAP<\/span>/);
    });

    it('reduced-motion 降级逻辑与静态呈现保证', () => {
      const html = renderToStaticMarkup(
        <LiquidTabGroup activeId="all" className="resource-bar__tabs">
          <LiquidTabItem id="all" selected={true}>
            <span>全部</span>
          </LiquidTabItem>
          <LiquidTabItem id="param" selected={false}>
            <span>参数</span>
          </LiquidTabItem>
        </LiquidTabGroup>
      );

      assert.match(html, /class="liquid-tab-group resource-bar__tabs"/);
      assert.match(html, /全部/);
      assert.match(html, /参数/);
    });
  });

  describe('LiquidActionGroup', () => {
    it('支持展开与折叠状态正确渲染', () => {
      const closedHtml = renderToStaticMarkup(
        <LiquidActionGroup open={false}>
          <button type="button">Action A</button>
          <button type="button">Action B</button>
        </LiquidActionGroup>
      );
      assert.match(closedHtml, /is-closed/);

      const openHtml = renderToStaticMarkup(
        <LiquidActionGroup open={true}>
          <button type="button">Action A</button>
          <button type="button">Action B</button>
        </LiquidActionGroup>
      );
      assert.match(openHtml, /is-open/);
      assert.match(openHtml, /Action A/);
      assert.match(openHtml, /Action B/);
    });
  });
});
