import assert from 'node:assert/strict';
import { it } from 'node:test';
import { placePopover, stepMenuIndex } from './popoverPlacement.js';

const viewport = { width: 1000, height: 600 };
const menu = { width: 200, height: 120 };

it('opens on the preferred side when it fits', () => {
  assert.deepEqual(placePopover({ left: 100, top: 10, width: 80, height: 24 }, menu, viewport, 'down'), { x: 100, y: 40, side: 'down' });
  assert.deepEqual(placePopover({ left: 100, top: 400, width: 80, height: 24 }, menu, viewport, 'up'), { x: 100, y: 274, side: 'up' });
});

it('flips to the other side when the preferred side is too short', () => {
  assert.equal(placePopover({ left: 100, top: 520, width: 80, height: 24 }, menu, viewport, 'down').side, 'up');
  assert.equal(placePopover({ left: 100, top: 20, width: 80, height: 24 }, menu, viewport, 'up').side, 'down');
});

it('when neither side fits it takes the larger side and stays inside the window', () => {
  const tall = { width: 200, height: 500 };
  const p = placePopover({ left: 100, top: 200, width: 80, height: 24 }, tall, viewport, 'up');
  assert.equal(p.side, 'down');
  assert.ok(p.y >= 8 && p.y + tall.height <= viewport.height - 8, JSON.stringify(p));
});

it('keeps the popover inside the window horizontally', () => {
  assert.equal(placePopover({ left: 900, top: 10, width: 80, height: 24 }, menu, viewport).x, 1000 - 8 - 200);
  assert.equal(placePopover({ left: -30, top: 10, width: 80, height: 24 }, menu, viewport).x, 8);
});

it('arrow keys wrap, Home and End jump, other keys are ignored', () => {
  assert.equal(stepMenuIndex('ArrowDown', 2, 3), 0);
  assert.equal(stepMenuIndex('ArrowUp', 0, 3), 2);
  assert.equal(stepMenuIndex('ArrowDown', -1, 3), 0);
  assert.equal(stepMenuIndex('ArrowUp', -1, 3), 2);
  assert.equal(stepMenuIndex('Home', 2, 3), 0);
  assert.equal(stepMenuIndex('End', 0, 3), 2);
  assert.equal(stepMenuIndex('a', 0, 3), null);
  assert.equal(stepMenuIndex('ArrowDown', 0, 0), null);
});
