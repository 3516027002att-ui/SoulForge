import assert from 'node:assert/strict';
import test from 'node:test';
import { presetForMode } from '../apps/desktop/src/renderer/src/theme/themeConfig.ts';
import { advanceFieldTime, createSpectralField, fallbackBackground, oklchToLinearRgb } from '../apps/desktop/src/renderer/src/theme/spectralField.ts';

// Deterministic browser ports exercise lifecycle and uploaded values. They do
// not compile GPU shaders or assert pixels, contrast, or rendered appearance.
class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    const values = this.listeners.get(type) ?? new Set(); values.add(callback); this.listeners.set(type, values);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) { for (const callback of this.listeners.get(type) ?? []) callback({ type }); }
  get count() { return [...this.listeners.values()].reduce((total, values) => total + values.size, 0); }
}

function fakeGl({ failCompile = false, renderer = null } = {}) {
  const calls = { draws: 0, createdShaders: [], createdPrograms: [], createdBuffers: [],
    deletedShaders: [], deletedPrograms: [], deletedBuffers: [], uniforms: new Map(), sources: [] };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, RED_BITS: 8, TRIANGLES: 9, RENDERER: 10,
    createShader: type => { const shader = { type }; calls.createdShaders.push(shader); return shader; }, shaderSource: (_shader, source) => calls.sources.push(source),
    compileShader() {}, getShaderParameter: () => !failCompile,
    createProgram: () => { const program = {}; calls.createdPrograms.push(program); return program; }, attachShader() {}, linkProgram() {}, getProgramParameter: () => true, useProgram() {},
    createBuffer: () => { const buffer = {}; calls.createdBuffers.push(buffer); return buffer; }, bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0,
    enableVertexAttribArray() {}, vertexAttribPointer() {}, getUniformLocation: (_program, name) => name,
    getExtension: name => name === 'WEBGL_debug_renderer_info' && renderer ? { UNMASKED_RENDERER_WEBGL: 11 } : null,
    getParameter: parameter => parameter === 10 ? 'WebKit WebGL' : parameter === 11 ? renderer : 8,
    viewport: (...values) => { calls.viewport = values; },
    uniform1f: (name, value) => calls.uniforms.set(name, value),
    uniform2f: (name, ...values) => calls.uniforms.set(name, values),
    uniform1fv: (name, values) => calls.uniforms.set(name, [...values]),
    uniform2fv: (name, values) => calls.uniforms.set(name, [...values]),
    uniform3fv: (name, values) => calls.uniforms.set(name, [...values]),
    drawArrays() { calls.draws++; }, deleteShader: shader => calls.deletedShaders.push(shader),
    deleteProgram: program => calls.deletedPrograms.push(program), deleteBuffer: buffer => calls.deletedBuffers.push(buffer)
  };
  return { gl, calls };
}

function withRuntime(options, body) {
  const names = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames = new Map(); let nextFrame = 0, now = 0;
  const reduce = Object.assign(new Events(), { matches: options.reduced ?? false });
  const styles = new Map();
  const document = Object.assign(new Events(), { hidden: false, documentElement: {
    dataset: {}, style: { setProperty: (name, value) => styles.set(name, value) }
  } });
  const window = Object.assign(new Events(), { devicePixelRatio: 3, matchMedia: () => reduce });
  const { gl, calls } = fakeGl(options);
  const canvas = Object.assign(new Events(), { dataset: {}, width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    getContext: () => options.noGl ? null : gl });
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  set('document', document); set('window', window); set('performance', { now: () => now });
  set('requestAnimationFrame', callback => { const id = ++nextFrame; frames.set(id, callback); return id; });
  set('cancelAnimationFrame', id => frames.delete(id));
  const step = time => {
    now = time;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(time);
  };
  try { body({ canvas, window, document, reduce, calls, frames, styles, step }); }
  finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('field clock excludes paused time and never advances backwards', () => {
  const clock = { time: 2, lastTick: null };
  advanceFieldTime(clock, 100, true, 0.1); advanceFieldTime(clock, 1100, true, 0.1);
  assert.equal(clock.time, 2.1);
  advanceFieldTime(clock, 1000, true, 0.1); assert.equal(clock.time, 2.1);
  advanceFieldTime(clock, 50000, false, 0.1);
  advanceFieldTime(clock, 100000, true, 0.1); assert.equal(clock.time, 2.1);
});

test('neutral OKLCH conversion is finite and disabled color intensity retains the base fallback', () => {
  for (const mode of ['opal', 'obsidian']) {
    const preset = presetForMode(mode);
    assert.ok(oklchToLinearRgb(preset.base.oklch).every(value => Number.isFinite(value) && value >= 0));
    preset.overallColorIntensity = 0;
    assert.equal(fallbackBackground(preset), 'var(--canvas)');
  }
  for (const value of oklchToLinearRgb({ l: 1, c: 0, h: 0 })) assert.ok(Math.abs(value - 1) < 1e-6);
});

test('owned field uploads each mode, caps backing dimensions and cleans every listener and GL allocation', () => {
  withRuntime({}, ports => {
    const field = createSpectralField(ports.canvas, presetForMode('opal'));
    try {
      assert.equal(field.available, true);
      assert.deepEqual(ports.calls.viewport, [0, 0, 1200, 900]);
      assert.equal(ports.canvas.width, 1200); assert.equal(ports.canvas.height, 900);
      assert.equal(ports.calls.uniforms.get('uMode'), 0);
      assert.equal(ports.calls.uniforms.get('uColors[0]').length, 18);
      assert.equal(ports.frames.size, 1);
      ports.step(250); assert.ok(ports.calls.draws >= 2);
      const dark = presetForMode('obsidian'); field.update(dark);
      assert.equal(ports.calls.uniforms.get('uMode'), 1);
      assert.equal(ports.calls.uniforms.get('uLuminanceCap'), dark.field.luminanceCap);
      assert.equal(ports.calls.uniforms.get('uTime'), dark.field.staticTime);
      ports.canvas.clientWidth = 400; ports.window.emit('resize');
      assert.deepEqual(ports.calls.viewport, [0, 0, 600, 900]);
      assert.equal(ports.canvas.width, 600); assert.equal(ports.canvas.height, 900);
    } finally { field.dispose(); }
    assert.equal(ports.frames.size, 0);
    assert.equal(ports.window.count + ports.document.count + ports.reduce.count + ports.canvas.count, 0);
    assert.equal(ports.calls.deletedShaders.length, 2);
    assert.equal(ports.calls.deletedPrograms.length, 1);
    assert.equal(ports.calls.deletedBuffers.length, 1);
    for (const kind of ['Shaders', 'Programs', 'Buffers']) {
      const created = ports.calls[`created${kind}`], deleted = ports.calls[`deleted${kind}`];
      assert.equal(new Set(deleted).size, created.length);
      assert.ok(created.every(allocation => deleted.includes(allocation)), 'cleanup must delete each actual owned allocation once');
    }
    const draws = ports.calls.draws; field.update(presetForMode('opal')); ports.step(2000);
    assert.equal(ports.calls.draws, draws);
  });
});

for (const renderer of [
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
  'llvmpipe (LLVM 20.1, 256 bits)',
  'softpipe',
  'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11, D3D11)'
]) {
  test(`software field retains shader motion with a bounded backing store: ${renderer}`, () => {
    withRuntime({ renderer }, ports => {
      ports.canvas.clientWidth = 1280; ports.canvas.clientHeight = 820;
      const field = createSpectralField(ports.canvas, presetForMode('opal'));
      try {
        assert.equal(field.available, true);
        assert.equal(ports.document.documentElement.dataset.ambient, 'shader');
        assert.ok(ports.canvas.width * ports.canvas.height <= 65_536, 'software ambient draw must stay within 65,536 pixels');
        assert.ok(Math.abs(ports.canvas.width / ports.canvas.height - 1280 / 820) < 0.02, 'budget preserves the viewport aspect ratio');
        assert.deepEqual(ports.calls.viewport, [0, 0, ports.canvas.width, ports.canvas.height]);
        const draws = ports.calls.draws;
        ports.step(250); assert.ok(ports.calls.draws > draws);
        assert.equal(ports.canvas.dataset.ambientMotion, 'on');
        ports.reduce.matches = true; ports.reduce.emit('change');
        const frozenDraws = ports.calls.draws; ports.step(2000);
        assert.equal(ports.calls.draws, frozenDraws); assert.equal(ports.frames.size, 0);
        ports.reduce.matches = false; ports.reduce.emit('change'); ports.step(2500);
        assert.ok(ports.calls.draws > frozenDraws); assert.equal(ports.frames.size, 1);
        ports.canvas.clientWidth = 3840; ports.canvas.clientHeight = 2160; ports.window.emit('resize');
        field.update(presetForMode('obsidian'));
        assert.ok(ports.canvas.width * ports.canvas.height <= 65_536, 'resize and theme changes retain the software budget');
      } finally { field.dispose(); }
    });
  });
}

test('hardware field preserves ordinary DPR detail and bounds ultra-wide monitor draws', () => {
  withRuntime({ renderer: 'ANGLE (Intel, Intel UHD Graphics, D3D11)' }, ports => {
    const field = createSpectralField(ports.canvas, presetForMode('opal'));
    try {
      assert.deepEqual(ports.calls.viewport, [0, 0, 1200, 900]);
      ports.canvas.clientWidth = 3840; ports.canvas.clientHeight = 2160; ports.window.emit('resize');
      assert.ok(ports.canvas.width * ports.canvas.height <= 1_500_000, 'ambient draw has a finite budget on high-DPR monitors too');
      assert.ok(Math.abs(ports.canvas.width / ports.canvas.height - 3840 / 2160) < 0.01);
      assert.equal(field.available, true); assert.equal(ports.frames.size, 1);
    } finally { field.dispose(); }
  });
});

test('reduced motion and hidden documents freeze scheduling without accumulating paused time', () => {
  withRuntime({ reduced: true }, ports => {
    const field = createSpectralField(ports.canvas, presetForMode('opal'));
    try {
      assert.equal(ports.frames.size, 0); assert.equal(ports.canvas.dataset.ambientMotion, 'off');
      ports.reduce.matches = false; ports.reduce.emit('change'); ports.step(250);
      assert.equal(ports.frames.size, 1);
      const time = ports.calls.uniforms.get('uTime');
      ports.document.hidden = true; ports.document.emit('visibilitychange');
      assert.equal(ports.frames.size, 0); ports.step(100000);
      ports.document.hidden = false; ports.document.emit('visibilitychange');
      assert.equal(ports.calls.uniforms.get('uTime'), time);
      assert.equal(ports.frames.size, 1);
    } finally { field.dispose(); }
  });
});

test('context loss switches to frozen CSS and cancels all animation', () => {
  withRuntime({}, ports => {
    const field = createSpectralField(ports.canvas, presetForMode('opal'));
    try {
      const draws = ports.calls.draws; ports.canvas.emit('webglcontextlost'); ports.step(5000);
      assert.equal(field.available, false); assert.equal(ports.frames.size, 0);
      assert.equal(ports.document.documentElement.dataset.ambient, 'css');
      assert.equal(ports.canvas.dataset.ambientMotion, 'off'); assert.equal(ports.calls.draws, draws);
      field.update(presetForMode('obsidian'));
      assert.equal(ports.styles.get('--field-fallback-background'), fallbackBackground(presetForMode('obsidian')));
    } finally { field.dispose(); }
  });
});

for (const options of [{ noGl: true }, { failCompile: true }]) {
  test(`unavailable field uses CSS and releases partially allocated shaders ${JSON.stringify(options)}`, () => {
    withRuntime(options, ports => {
      const field = createSpectralField(ports.canvas, presetForMode('opal'));
      try {
        assert.equal(field.available, false); assert.equal(ports.frames.size, 0);
        assert.equal(ports.document.documentElement.dataset.ambient, 'css');
        assert.equal(ports.calls.draws, 0);
        assert.ok(ports.styles.get('--field-fallback-background').endsWith('var(--canvas)'));
        assert.equal(ports.calls.deletedShaders.length, options.failCompile ? 1 : 0);
      } finally { field.dispose(); }
      assert.equal(ports.window.count + ports.document.count + ports.reduce.count + ports.canvas.count, 0);
    });
  });
}
