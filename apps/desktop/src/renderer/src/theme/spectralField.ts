import type { OklchColor, SpectralManifest } from './themeConfig.js';

const VERTEX_SHADER = `
    attribute vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
const FRAGMENT_SHADER = `
    precision highp float;

    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uSeed;
    uniform float uMode;
    uniform float uOverall;
    uniform float uScale;
    uniform float uOctaves;
    uniform float uWarp;
    uniform float uDither;
    uniform float uLuminanceCap;
    uniform float uLevels;
    uniform vec3 uBase;
    uniform vec3 uColors[6];
    uniform float uStrengths[6];
    uniform float uFieldScales[6];
    uniform vec2 uPhases[6];

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32 + uSeed * 0.00013);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.52;
      mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
      for (int i = 0; i < 5; i++) {
        if (float(i) + 0.5 >= uOctaves) break;
        value += amplitude * noise(p);
        p = rotation * p * 2.03 + vec2(13.1, 7.7);
        amplitude *= 0.48;
      }
      return value;
    }

    float colorField(vec2 p, vec2 phase, float index, float fieldScale) {
      float angle = 0.43 + index * 1.0472 + phase.x * 0.54;
      vec2 direction = vec2(cos(angle), sin(angle));
      float cloud = fbm(p * fieldScale + phase * 6.0);
      float riverNoise = fbm(p * 0.48 + phase * 3.7);
      float river = 0.5 + 0.5 * sin(
        dot(p, direction) * (1.15 + fieldScale * 0.56)
        + phase.y * 6.2832
        + riverNoise * 3.4
      );
      return clamp(cloud * 0.54 + river * 0.62 - 0.12, 0.0, 1.0);
    }

    vec3 toneMap(vec3 c) {
      return c / (1.0 + max(c - 1.0, 0.0));
    }

    vec3 linearToSrgb(vec3 c) {
      vec3 high = 1.055 * pow(max(c, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055;
      return mix(c * 12.92, high, step(vec3(0.0031308), c));
    }

    // Not hash21: offsetting pixel coordinates by the seed pushes them past
    // float precision, and the dither turns into visible stripes.
    float ditherHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution.xy;
      vec2 p = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
      p *= uScale;

      float time = uTime;
      vec2 driftA = vec2(cos(time * 0.71), sin(time * 0.63)) * 0.11;
      vec2 driftB = vec2(sin(time * 0.47), cos(time * 0.57)) * 0.09;
      vec2 q = vec2(
        fbm(p + vec2(0.0, 0.0) + driftA),
        fbm(p + vec2(5.2, 1.3) - driftB)
      );
      vec2 r = vec2(
        fbm(p + uWarp * q * 2.3 + vec2(1.7, 8.2) + driftB),
        fbm(p + uWarp * q * 2.3 + vec2(8.3, 2.8) - driftA)
      );
      vec2 warped = p + uWarp * (q - 0.5) * 2.1 + uWarp * 0.72 * (r - 0.5);

      vec3 colorSum = vec3(0.0);
      float weightSum = 0.0;
      float energySum = 0.0;
      float strongestBand = 0.0;
      float spectralFlow = fract(
        fbm(warped * 0.92 + q * 0.42) * 2.05
        + dot(warped, vec2(0.72, -0.49))
        + uSeed * 0.000017
      );
      for (int i = 0; i < 6; i++) {
        float hueStop = float(i) / 6.0;
        float hueDistance = abs(spectralFlow - hueStop);
        hueDistance = min(hueDistance, 1.0 - hueDistance);
        float hueBand = 1.0 - smoothstep(0.035, 0.205, hueDistance);
        if (hueBand <= 0.0) continue;
        float field = colorField(
          warped + q * (0.21 + float(i) * 0.025),
          uPhases[i],
          float(i),
          uFieldScales[i]
        );
        float softBand = smoothstep(0.22, 0.78, field);
        float shapedBand = pow(hueBand, 2.2) * (0.64 + softBand * 0.36);
        float weight = shapedBand * sqrt(max(uStrengths[i], 0.0));
        colorSum += uColors[i] * weight;
        weightSum += weight;
        energySum += shapedBand * uStrengths[i];
        strongestBand = max(strongestBand, shapedBand);
      }

      vec3 palette = weightSum > 0.0001 ? colorSum / weightSum : uBase;
      float globalField = fbm(warped * 0.58 + q * 0.3);
      float fieldEnergy = clamp(energySum * 3.6 + strongestBand * 0.18 + globalField * 0.12, 0.0, 1.0);
      float mixAmount;

      if (uMode < 0.5) {
        mixAmount = clamp(uOverall * (0.08 + fieldEnergy * 0.46), 0.0, 0.62);
      } else {
        mixAmount = clamp(uOverall * (0.10 + fieldEnergy * 0.92), 0.0, 0.92);
      }

      vec3 color = mix(uBase, palette, mixAmount);

      if (uMode > 0.5) {
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        if (luminance > uLuminanceCap) {
          color *= uLuminanceCap / max(luminance, 0.0001);
        }
      }

      vec2 pixel = floor(gl_FragCoord.xy);
      float triangle = ditherHash(pixel) + ditherHash(pixel + vec2(47.0, 113.0)) - 1.0;
      vec3 encoded = linearToSrgb(toneMap(max(color, 0.0)));
      // Quantize here so the result does not depend on whether the GPU rounds or
      // truncates when it stores floats; +0.25 lands inside the chosen code either way.
      vec3 code = clamp(floor(encoded * uLevels + 0.5 + triangle * uDither), 0.0, uLevels);
      gl_FragColor = vec4((code + 0.25) / uLevels, 1.0);
    }
  `;

/** Shader and palette math adapted from liuguang-banlan-ui PR #1743 (MIT). */
export function oklchToLinearRgb(color: OklchColor): number[] {
  const angle = color.h * Math.PI / 180;
  const a = color.c * Math.cos(angle), b = color.c * Math.sin(angle);
  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ];
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.slice(1);
  return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha.toFixed(5)})`;
}

/** A static directional spectral sweep is also a safe frozen fallback. */
export function fallbackBackground(config: SpectralManifest): string {
  const layers: string[] = [];
  config.colors.forEach((entry, index) => {
    const strength = entry.intensity * entry.peakOpacity * config.overallColorIntensity;
    if (strength <= 0) return;
    const angle = Math.round(index * 137.5 + config.seed * 0.11);
    const alpha = Math.min(0.82, strength * 0.95);
    layers.push(`linear-gradient(${angle}deg, transparent 6%, ${hexToRgba(entry.srgbFallback, alpha * 0.35)} 28%, ${hexToRgba(entry.srgbFallback, alpha)} 48%, ${hexToRgba(entry.srgbFallback, alpha * 0.32)} 68%, transparent 90%)`);
  });
  return [...layers, 'var(--canvas)'].join(', ');
}

export interface FieldClock { time: number; lastTick: number | null }
export function advanceFieldTime(clock: FieldClock, now: number, moving: boolean, speed: number): void {
  if (!moving) { clock.lastTick = null; return; }
  if (clock.lastTick !== null) clock.time += Math.max(0, now - clock.lastTick) * speed / 1000;
  clock.lastTick = now;
}

export interface SpectralFieldHandle {
  readonly available: boolean;
  update: (config: SpectralManifest) => void;
  dispose: () => void;
}

/** Owns only the ambient canvas. It never changes editor layout or scene cameras. */
export function createSpectralField(canvas: HTMLCanvasElement, initial: SpectralManifest): SpectralFieldHandle {
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let config = initial;
  const clock: FieldClock = { time: initial.field.staticTime, lastTick: null };
  let disposed = false, available = false, raf = 0, lastFrame = Number.NEGATIVE_INFINITY;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let gl: WebGLRenderingContext | null = null;

  const applyFallback = (): void => {
    root.style.setProperty('--field-fallback-background', fallbackBackground(config));
  };
  applyFallback();

  const cleanupGl = (): void => {
    if (!gl) return;
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    shaders.length = 0;
    buffer = null; program = null;
  };

  let upload = (): void => {};
  let paint = (): void => {};
  try {
    gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power', preserveDrawingBuffer: true
    });
    if (!gl) throw new Error('WebGL unavailable');
    const context = gl;
    for (const [type, source] of [[context.VERTEX_SHADER, VERTEX_SHADER], [context.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
      const shader = context.createShader(type);
      if (!shader) throw new Error('Shader unavailable');
      shaders.push(shader);
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error('Shader compilation failed');
    }
    program = context.createProgram();
    if (!program) throw new Error('Program unavailable');
    for (const shader of shaders) context.attachShader(program, shader);
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error('Shader linking failed');
    context.useProgram(program);
    buffer = context.createBuffer();
    if (!buffer) throw new Error('Buffer unavailable');
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), context.STATIC_DRAW);
    const position = context.getAttribLocation(program, 'aPosition');
    if (position < 0) throw new Error('Position attribute unavailable');
    context.enableVertexAttribArray(position);
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    const location = (name: string): WebGLUniformLocation | null => context.getUniformLocation(program!, name);
    const locations = {
      resolution: location('uResolution'), time: location('uTime'), seed: location('uSeed'),
      mode: location('uMode'), overall: location('uOverall'), scale: location('uScale'),
      octaves: location('uOctaves'), warp: location('uWarp'), dither: location('uDither'),
      cap: location('uLuminanceCap'), levels: location('uLevels'), base: location('uBase'),
      colors: location('uColors[0]'), strengths: location('uStrengths[0]'),
      fieldScales: location('uFieldScales[0]'), phases: location('uPhases[0]')
    };
    const levels = 2 ** (context.getParameter(context.RED_BITS) || 8) - 1;
    upload = (): void => {
      context.useProgram(program);
      context.uniform1f(locations.seed, config.seed);
      context.uniform1f(locations.mode, config.mode === 'obsidian' ? 1 : 0);
      context.uniform1f(locations.overall, config.overallColorIntensity);
      context.uniform1f(locations.scale, config.field.scale);
      context.uniform1f(locations.octaves, config.field.octaves);
      context.uniform1f(locations.warp, config.field.warpStrength);
      context.uniform1f(locations.dither, config.field.ditherStrength);
      context.uniform1f(locations.cap, config.field.luminanceCap ?? 1);
      context.uniform1f(locations.levels, levels);
      context.uniform3fv(locations.base, new Float32Array(oklchToLinearRgb(config.base.oklch)));
      context.uniform3fv(locations.colors, new Float32Array(config.colors.flatMap((entry) => oklchToLinearRgb(entry.oklch))));
      context.uniform1fv(locations.strengths, new Float32Array(config.colors.map((entry) => entry.intensity * entry.peakOpacity * 3)));
      context.uniform1fv(locations.fieldScales, new Float32Array(config.colors.map((entry) => entry.fieldScale)));
      context.uniform2fv(locations.phases, new Float32Array(config.colors.flatMap((entry) => entry.phase)));
    };
    paint = (): void => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
        context.viewport(0, 0, width, height);
      }
      context.uniform2f(locations.resolution, width, height);
      context.uniform1f(locations.time, clock.time);
      context.drawArrays(context.TRIANGLES, 0, 6);
    };
    available = true;
    upload();
    root.dataset.ambient = 'shader';
  } catch {
    cleanupGl();
    root.dataset.ambient = 'css';
  }

  const moving = (): boolean => available && !reduce.matches && !document.hidden;
  const motionState = (): void => { canvas.dataset.ambientMotion = moving() ? 'on' : 'off'; };
  const cancel = (): void => { cancelAnimationFrame(raf); raf = 0; };
  const interval = (): number => Math.min(250, Math.max(50, 0.003 / Math.max(config.field.motionSpeed, 0.000001) * 1000));
  const render = (now: number, force: boolean): void => {
    if (disposed || !available) return;
    if (!force && now - lastFrame < interval()) { schedule(); return; }
    lastFrame = now;
    advanceFieldTime(clock, now, moving(), config.field.motionSpeed);
    paint();
    motionState();
  };
  const schedule = (): void => {
    if (disposed || !moving() || raf) return;
    raf = requestAnimationFrame((now) => { raf = 0; render(now, false); schedule(); });
  };
  const onMotion = (): void => {
    cancel(); clock.lastTick = null; motionState();
    if (!document.hidden) { render(performance.now(), true); schedule(); }
  };
  const onResize = (): void => { render(performance.now(), true); };
  const onContextLost = (): void => {
    available = false; cancel(); clock.lastTick = null;
    root.dataset.ambient = 'css'; motionState();
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onMotion);
  reduce.addEventListener('change', onMotion);
  canvas.addEventListener('webglcontextlost', onContextLost);
  motionState();
  render(performance.now(), true);
  schedule();
  return {
    get available(): boolean { return available; },
    update(next): void {
      if (disposed) return;
      if (next.mode !== config.mode) { clock.time = next.field.staticTime; clock.lastTick = null; }
      config = next; applyFallback();
      if (available) { upload(); render(performance.now(), true); schedule(); }
    },
    dispose(): void {
      disposed = true; cancel(); cleanupGl();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onMotion);
      reduce.removeEventListener('change', onMotion);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      root.dataset.ambient = 'css';
      canvas.dataset.ambientMotion = 'off';
    }
  };
}
