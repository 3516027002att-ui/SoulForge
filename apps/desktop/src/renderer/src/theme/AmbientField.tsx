import { useEffect, useRef, type ReactElement } from 'react';

const AMBIENT_MAX_FPS = 24;
const AMBIENT_FRAME_INTERVAL_MS = 1000 / AMBIENT_MAX_FPS;

/**
 * 流光溢彩白 V3：全窗口 WebGL 虹彩环境场。
 *
 * 只提供材质，不带动布局/圆角/hero。WebGL 失败或暗色主题时退回
 * styles.css 的 body 伪元素。动画只改 uniform time；reduced-motion 停在静帧。
 */
const VERTEX = `
attribute vec2 a;
void main(){gl_Position=vec4(a,0.0,1.0);}
`;

const FRAGMENT = `
precision highp float;
uniform vec2 res;
uniform float time;
uniform float active;

float hash(vec2 p){
  p=fract(p*vec2(123.34,456.21));
  p+=dot(p,p+45.32);
  return fract(p.x*p.y);
}

float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  float a=hash(i);
  float b=hash(i+vec2(1.,0.));
  float c=hash(i+vec2(0.,1.));
  float d=hash(i+vec2(1.,1.));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
}

float fbm(vec2 p){
  float v=0.0;
  float a=.5;
  mat2 m=mat2(1.62,-1.17,1.17,1.62);
  for(int i=0;i<5;i++){
    v+=a*noise(p);
    p=m*p+0.13;
    a*=.5;
  }
  return v;
}

vec3 tintPalette(float x){
  x=fract(x);
  vec3 mint = vec3(-.070,  .038, -.015);
  vec3 ice  = vec3(-.085, -.030,  .064);
  vec3 lilac= vec3( .021, -.070,  .070);
  vec3 peach= vec3( .050, -.064, -.090);
  vec3 gold = vec3( .044,  .009, -.085);
  if(x<.20) return mix(mint,ice,x/.20);
  if(x<.40) return mix(ice,lilac,(x-.20)/.20);
  if(x<.62) return mix(lilac,peach,(x-.40)/.22);
  if(x<.82) return mix(peach,gold,(x-.62)/.20);
  return mix(gold,mint,(x-.82)/.18);
}

void main(){
  vec2 uv=gl_FragCoord.xy/res;
  float aspect=res.x/res.y;
  vec2 p=vec2(uv.x*aspect,uv.y);
  float t=time*mix(.010,.026,active);
  vec2 q=vec2(
    fbm(p*.56+vec2(0.0,t)),
    fbm(p*.56+vec2(5.7,-t*.73))
  );
  vec2 r=vec2(
    fbm(p*.32+1.85*q+vec2(1.7,t*.25)),
    fbm(p*.32+1.85*q+vec2(7.4,-t*.22))
  );
  float phase1 = uv.x*.62 - uv.y*.10 + (r.x-.5)*.44 + (r.y-.5)*.20 + t*.14;
  float phase2 = uv.y*.30 + uv.x*.14 + (q.y-.5)*.50 - (q.x-.5)*.18 - t*.10 + .19;
  vec3 tint=mix(tintPalette(phase1),tintPalette(phase2),.32);
  float shape=
      .78
    + .28*(fbm(p*.24+2.1*r)-.5)
    + .15*sin(uv.x*2.8 - uv.y*1.6 + r.x*2.5 + t*.18);
  shape=clamp(shape,.60,1.0);
  vec3 base=vec3(.986,.985,.978);
  vec3 color=base+tint*shape;
  float veil=.012+.022*fbm(p*.18+vec2(2.0,-1.0));
  color=mix(color,vec3(.995,.994,.990),veil);
  vec2 c=uv-.5;
  float edge=smoothstep(.42,.82,length(c*vec2(.80,1.0)));
  color=mix(color,base,edge*.024);
  float d=hash(gl_FragCoord.xy+mod(time*41.0,113.0))-.5;
  color+=d*(0.90/255.0);
  gl_FragColor=vec4(clamp(color,0.0,1.0),1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function AmbientField(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    const root = document.documentElement;
    if (!canvasEl) return;
    const canvas = canvasEl;

    const context = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power'
    });
    if (!context) {
      root.dataset.ambient = 'css';
      return;
    }
    const gl = context;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) {
      root.dataset.ambient = 'css';
      return;
    }
    const program = gl.createProgram();
    if (!program) {
      root.dataset.ambient = 'css';
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      root.dataset.ambient = 'css';
      return;
    }
    gl.useProgram(program);

    const locA = gl.getAttribLocation(program, 'a');
    const locRes = gl.getUniformLocation(program, 'res');
    const locTime = gl.getUniformLocation(program, 'time');
    const locActive = gl.getUniformLocation(program, 'active');
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(locA);
    gl.vertexAttribPointer(locA, 2, gl.FLOAT, false, 0, 0);

    root.dataset.ambient = 'shader';
    const start = performance.now();
    let raf = 0;
    let running = true;
    let lastDrawAt = Number.NEGATIVE_INFINITY;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    function isLight(): boolean {
      return document.documentElement.dataset.theme !== 'dark';
    }

    function resize(): void {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(window.innerWidth * dpr));
      const height = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${window.innerWidth}px`;
        canvas.style.height = `${window.innerHeight}px`;
        gl.viewport(0, 0, width, height);
      }
    }

    function draw(now: number): void {
      if (!running) return;
      resize();
      if (!isLight()) {
        canvas.dataset.ambientMotion = 'off';
        return;
      }
      if (!reduce.matches && now - lastDrawAt < AMBIENT_FRAME_INTERVAL_MS) {
        if (!document.hidden) raf = requestAnimationFrame(draw);
        return;
      }
      lastDrawAt = now;
      gl.uniform2f(locRes, canvas.width, canvas.height);
      gl.uniform1f(locTime, (now - start) / 1000);
      gl.uniform1f(locActive, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      canvas.dataset.ambientMotion = reduce.matches ? 'off' : 'on';
      if (!document.hidden && !reduce.matches) raf = requestAnimationFrame(draw);
    }

    function kick(): void {
      cancelAnimationFrame(raf);
      lastDrawAt = Number.NEGATIVE_INFINITY;
      raf = requestAnimationFrame(draw);
    }

    const onReduce = (): void => { kick(); };
    const onVisibility = (): void => { kick(); };
    reduce.addEventListener('change', onReduce);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', kick);
    const themeObserver = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => kick())
      : null;
    themeObserver?.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    kick();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      reduce.removeEventListener('change', onReduce);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', kick);
      themeObserver?.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (document.documentElement.dataset.ambient === 'shader') {
        document.documentElement.dataset.ambient = 'css';
      }
    };
  }, []);

  return (
    <canvas
      id="sf-ambient-field"
      ref={canvasRef}
      className="sf-ambient-field"
      aria-hidden="true"
      data-testid="sf-ambient-field"
    />
  );
}
