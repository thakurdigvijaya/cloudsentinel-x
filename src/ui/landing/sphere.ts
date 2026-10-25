// The Evidence Sphere: a particle sphere that carries the real resources of the loaded dataset as nodes.
// WebGL (hand-written GLSL, no library) with an automatic Canvas 2D fallback. Pure rendering: it knows nothing about
// the engine; the page gives it node targets (position, colour, shape, size) and it tweens to them.
// Premultiplied alpha, no additive blending, so the same drawing reads on the pale Day panel and the dark Twilight one.

export type Shape = 0 | 1 | 2; // 0 disc, 1 ring, 2 diamond: the verdict is never colour-only
export interface NodeTarget {
  x: number; y: number; z: number; // position in sphere units (the sphere has radius 1)
  r: number; g: number; b: number; a: number; // colour 0..1 and opacity
  size: number; // fraction of the sphere radius
  shape: Shape;
  glow: number; // 0..1
}
export interface Placement { cx: number; cy: number; r: number } // CSS pixels
export type RGB = [number, number, number]; // 0..1

const D = 3.4; // camera distance in sphere radii
const NODE_STRIDE = 9;

const DUST_VS = `
attribute vec3 aPos; attribute vec4 aSeed;
uniform vec2 uRes; uniform vec2 uC; uniform float uR; uniform float uYaw; uniform float uPitch;
uniform float uTime; uniform float uIntro; uniform float uDpr; uniform float uBase; uniform vec3 uWhite; uniform vec3 uGold; uniform float uBoost;
varying vec4 vCol;
void main(){
  float k = smoothstep(aSeed.w*0.7, aSeed.w*0.7+0.3, uIntro);
  vec3 p = aPos * (0.55 + 0.45*k) * (1.0 + 0.012*sin(uTime*0.7 + aSeed.x*6.2831));
  float cy = cos(uYaw), sy = sin(uYaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  float cp = cos(uPitch), sp = sin(uPitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  float s = ${D.toFixed(1)}/(${D.toFixed(1)} - p.z);
  vec2 px = uC + vec2(p.x, -p.y)*uR*s;
  gl_Position = vec4(px.x/uRes.x*2.0-1.0, 1.0-px.y/uRes.y*2.0, 0.0, 1.0);
  float d = clamp((p.z+1.0)*0.5, 0.0, 1.0);
  gl_PointSize = max(1.0, uBase*(0.5+aSeed.y)*s*uDpr*(uR/300.0)*k);
  vec3 col = aSeed.z < 0.62 ? uWhite : uGold;
  float al = (0.30 + 0.62*d) * 0.92 * k * uBoost;
  vCol = vec4(col*al, al);
}`;
const DUST_FS = `
precision mediump float; varying vec4 vCol;
void main(){ float d = length(gl_PointCoord-0.5)*2.0; float a = 1.0 - smoothstep(0.0, 1.0, d); gl_FragColor = vCol*(a*a); }`;

const NODE_VS = `
attribute vec2 aPx; attribute float aSize; attribute vec4 aCol; attribute float aShape; attribute float aGlow;
uniform vec2 uRes; uniform float uDpr;
varying vec4 vCol; varying float vShape; varying float vGlow;
void main(){
  gl_Position = vec4(aPx.x/uRes.x*2.0-1.0, 1.0-aPx.y/uRes.y*2.0, 0.0, 1.0);
  gl_PointSize = max(2.0, aSize*(1.0+aGlow*2.2)*2.0*uDpr);
  vCol = aCol; vShape = aShape; vGlow = aGlow;
}`;
const NODE_FS = `
precision mediump float; varying vec4 vCol; varying float vShape; varying float vGlow; uniform float uDark;
void main(){
  vec2 uv = (gl_PointCoord-0.5)*2.0;
  float rc = 1.0/(1.0+vGlow*2.2);
  float l = length(uv);
  float sdf;
  if (vShape < 0.5) sdf = l/rc - 1.0;
  else if (vShape < 1.5) sdf = abs(l/rc - 0.72) - 0.26;
  else sdf = (abs(uv.x)+abs(uv.y))/(rc*1.15) - 1.0;
  float body = 1.0 - smoothstep(-0.07, 0.07, sdf);
  float halo = exp(-l*l*3.2) * vGlow * (0.42 + uDark*0.4);
  float spec = vShape < 0.5 ? smoothstep(0.55, 0.0, length(uv - vec2(-0.22,-0.24)*rc)) * 0.30 * body : 0.0;
  vec3 col = vCol.rgb + vec3(spec);
  float a = clamp(body + halo, 0.0, 1.0) * vCol.a;
  gl_FragColor = vec4(col*a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}
function program(gl: WebGLRenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points spread evenly over a sphere (golden-angle spiral). */
export function fibonacciSphere(n: number, radius = 1): [number, number, number][] {
  const out: [number, number, number][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = ga * i;
    out.push([Math.cos(t) * r * radius, y * radius, Math.sin(t) * r * radius]);
  }
  return out;
}

interface Opts {
  dust: number;
  reduced: boolean;
  forceCanvas2d?: boolean;
  onLost?: () => void;
}

export class SphereScene {
  readonly mode: 'webgl' | 'canvas2d';
  readonly count: number;
  yaw = 0.6;
  /** Twilight: stronger halos around glowing nodes */
  dark = false;
  /** the two dust colours (most points, and the accent minority) and a brightness multiplier */
  dustColors: { main: RGB; accent: RGB; boost: number } = { main: [0.16, 0.36, 0.33], accent: [0.8, 0.58, 0.4], boost: 1 };
  private yawVel = 0;
  private pitchDrag = 0;
  pointer = { x: 0, y: 0 };
  intro = 0;
  placement: Placement = { cx: 300, cy: 300, r: 200 };
  private target: Placement = { cx: 300, cy: 300, r: 200 };
  private w = 1;
  private h = 1;
  private dpr = 1;
  reduced: boolean;
  // nodes: current and target, struct-of-arrays
  private cur: Float32Array;
  private tgt: Float32Array;
  private shapes: Uint8Array;
  private order: number[];
  /** screen-space result of the last frame, used for picking and tooltips */
  readonly sx: Float32Array;
  readonly sy: Float32Array;
  readonly ss: Float32Array;
  readonly sz: Float32Array;
  // webgl
  private gl: WebGLRenderingContext | null = null;
  private dustProg: WebGLProgram | null = null;
  private nodeProg: WebGLProgram | null = null;
  private dustBuf: WebGLBuffer | null = null;
  private nodeBuf: WebGLBuffer | null = null;
  private nodeData: Float32Array;
  private dustCount: number;
  // canvas2d fallback
  private ctx: CanvasRenderingContext2D | null = null;
  private dustPos: Float32Array;
  private dustSeed: Float32Array;

  constructor(private canvas: HTMLCanvasElement, nodes: number, opts: Opts) {
    this.reduced = opts.reduced;
    this.count = nodes;
    const F = 10; // x y z r g b a size glow shape
    this.cur = new Float32Array(nodes * F);
    this.tgt = new Float32Array(nodes * F);
    this.shapes = new Uint8Array(nodes);
    this.order = Array.from({ length: nodes }, (_, i) => i);
    this.sx = new Float32Array(nodes);
    this.sy = new Float32Array(nodes);
    this.ss = new Float32Array(nodes);
    this.sz = new Float32Array(nodes);
    this.nodeData = new Float32Array(nodes * NODE_STRIDE);
    this.dustCount = opts.dust;
    // dust: points in a thin shell with a little thickness, seeded so it is identical on every visit
    const rnd = mulberry(20261024);
    this.dustPos = new Float32Array(this.dustCount * 3);
    this.dustSeed = new Float32Array(this.dustCount * 4);
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < this.dustCount; i++) {
      const y = 1 - ((i + 0.5) / this.dustCount) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = ga * i;
      const shell = 0.9 + rnd() * 0.1 + (rnd() < 0.08 ? rnd() * 0.12 : 0);
      this.dustPos.set([Math.cos(t) * r * shell, y * shell, Math.sin(t) * r * shell], i * 3);
      this.dustSeed.set([rnd(), rnd(), rnd(), rnd()], i * 4);
    }
    let gl: WebGLRenderingContext | null = null;
    if (!opts.forceCanvas2d) {
      try {
        gl = (canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'default' }) as WebGLRenderingContext | null);
        if (gl) this.initGl(gl);
      } catch {
        gl = null;
      }
    }
    if (gl && this.gl) {
      this.mode = 'webgl';
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.gl = null;
        opts.onLost?.();
      });
    } else {
      this.gl = null;
      this.mode = 'canvas2d';
      this.ctx = canvas.getContext('2d');
    }
  }

  private initGl(gl: WebGLRenderingContext) {
    this.dustProg = program(gl, DUST_VS, DUST_FS);
    this.nodeProg = program(gl, NODE_VS, NODE_FS);
    this.dustBuf = gl.createBuffer();
    this.nodeBuf = gl.createBuffer();
    const data = new Float32Array(this.dustCount * 7);
    for (let i = 0; i < this.dustCount; i++) {
      data.set(this.dustPos.subarray(i * 3, i * 3 + 3), i * 7);
      data.set(this.dustSeed.subarray(i * 4, i * 4 + 4), i * 7 + 3);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dustBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.gl = gl;
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /** Where the sphere sits on screen. Tweens unless motion is reduced. */
  place(p: Placement, immediate = false) {
    this.target = p;
    if (immediate || this.reduced) this.placement = { ...p };
  }

  /** New node targets: tween there (or jump when motion is reduced). */
  setTargets(t: NodeTarget[], immediate = false) {
    const F = 10;
    for (let i = 0; i < this.count; i++) {
      const n = t[i];
      if (!n) continue;
      this.tgt.set([n.x, n.y, n.z, n.r, n.g, n.b, n.a, n.size, n.glow, n.shape], i * F);
      this.shapes[i] = n.shape;
      if (immediate || this.reduced) this.cur.set(this.tgt.subarray(i * F, i * F + F), i * F);
    }
  }

  /** Drag: rotate. dx/dy in CSS pixels. */
  drag(dx: number, dy: number) {
    this.yawVel += dx * 0.012;
    this.pitchDrag = Math.max(-0.6, Math.min(0.6, this.pitchDrag + dy * 0.004));
  }

  /** Nearest node under the pointer, or -1. Front-facing nodes win. */
  pick(px: number, py: number): number {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dx = px - this.sx[i];
      const dy = py - this.sy[i];
      const rad = Math.max(11, this.ss[i] * 1.15);
      const d2 = dx * dx + dy * dy;
      if (d2 > rad * rad) continue;
      const score = d2 / (rad * rad) - this.sz[i] * 0.4;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  frame(dt: number, time: number) {
    const soft = this.reduced ? 1 : 1 - Math.exp(-dt / 0.42);
    // placement and intro
    this.placement.cx += (this.target.cx - this.placement.cx) * soft;
    this.placement.cy += (this.target.cy - this.placement.cy) * soft;
    this.placement.r += (this.target.r - this.placement.r) * soft;
    this.intro = this.reduced ? 1 : Math.min(1, this.intro + dt / 2.6);
    // rotation: slow spin, inertia from drags, pitch relaxes back to rest
    if (!this.reduced) {
      this.yaw += (0.07 + this.yawVel) * dt;
      this.yawVel *= Math.exp(-dt * 2.0);
      this.pitchDrag *= Math.exp(-dt * 0.9);
    }
    const yaw = this.yaw + this.pointer.x * 0.16;
    const pitch = 0.26 + this.pointer.y * 0.1 + this.pitchDrag;
    // tween nodes
    const F = 10;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / 0.3);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const { cx, cy: cyy, r } = this.placement;
    const bob = this.reduced ? 0 : Math.sin(time * 0.8) * r * 0.012;
    for (let i = 0; i < this.count; i++) {
      const o = i * F;
      for (let j = 0; j < F - 1; j++) this.cur[o + j] += (this.tgt[o + j] - this.cur[o + j]) * k;
      let x = this.cur[o], y = this.cur[o + 1], z = this.cur[o + 2];
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      const y2 = cp * y - sp * z1;
      const z2 = sp * y + cp * z1;
      x = x1; y = y2; z = z2;
      const s = D / (D - z);
      this.sx[i] = cx + x * r * s;
      this.sy[i] = cyy + bob - y * r * s;
      this.ss[i] = this.cur[o + 7] * r * s;
      this.sz[i] = z;
    }
    this.order.sort((a, b) => this.sz[a] - this.sz[b]);
    if (this.gl) this.drawGl(yaw, pitch, time);
    else if (this.ctx) this.draw2d(yaw, pitch);
  }

  private drawGl(yaw: number, pitch: number, time: number) {
    const gl = this.gl!;
    const { cx, cy, r } = this.placement;
    const bob = this.reduced ? 0 : Math.sin(time * 0.8) * r * 0.012;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // dust
    let p = this.dustProg!;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dustBuf);
    const aPos = gl.getAttribLocation(p, 'aPos');
    const aSeed = gl.getAttribLocation(p, 'aSeed');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aSeed);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 28, 0);
    gl.vertexAttribPointer(aSeed, 4, gl.FLOAT, false, 28, 12);
    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), this.w, this.h);
    gl.uniform2f(gl.getUniformLocation(p, 'uC'), cx, cy + bob);
    gl.uniform1f(gl.getUniformLocation(p, 'uR'), r);
    gl.uniform1f(gl.getUniformLocation(p, 'uYaw'), yaw);
    gl.uniform1f(gl.getUniformLocation(p, 'uPitch'), pitch);
    gl.uniform1f(gl.getUniformLocation(p, 'uTime'), time);
    gl.uniform1f(gl.getUniformLocation(p, 'uIntro'), this.intro);
    gl.uniform1f(gl.getUniformLocation(p, 'uDpr'), this.dpr);
    gl.uniform1f(gl.getUniformLocation(p, 'uBase'), 3.2);
    gl.uniform3f(gl.getUniformLocation(p, 'uWhite'), ...this.dustColors.main);
    gl.uniform3f(gl.getUniformLocation(p, 'uGold'), ...this.dustColors.accent);
    gl.uniform1f(gl.getUniformLocation(p, 'uBoost'), this.dustColors.boost);
    gl.drawArrays(gl.POINTS, 0, this.dustCount);
    gl.disableVertexAttribArray(aPos);
    gl.disableVertexAttribArray(aSeed);
    // nodes (sorted far to near)
    p = this.nodeProg!;
    gl.useProgram(p);
    const d = this.nodeData;
    const F = 10;
    const nodeAlpha = this.reduced ? 1 : Math.max(0, Math.min(1, (this.intro - 0.45) / 0.45));
    for (let n = 0; n < this.count; n++) {
      const i = this.order[n];
      const o = i * F;
      const depth = Math.max(0, Math.min(1, (this.sz[i] + 1.2) / 2.4));
      const b = n * NODE_STRIDE;
      d[b] = this.sx[i];
      d[b + 1] = this.sy[i] + bob;
      d[b + 2] = this.ss[i];
      d[b + 3] = this.cur[o + 3];
      d[b + 4] = this.cur[o + 4];
      d[b + 5] = this.cur[o + 5];
      d[b + 6] = this.cur[o + 6] * (0.42 + 0.58 * depth) * nodeAlpha;
      d[b + 7] = this.shapes[i];
      d[b + 8] = this.cur[o + 8];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    const stride = NODE_STRIDE * 4;
    const loc = (n: string) => gl.getAttribLocation(p, n);
    const aPx = loc('aPx'), aSize = loc('aSize'), aCol = loc('aCol'), aShape = loc('aShape'), aGlow = loc('aGlow');
    [aPx, aSize, aCol, aShape, aGlow].forEach((a) => gl.enableVertexAttribArray(a));
    gl.vertexAttribPointer(aPx, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, stride, 12);
    gl.vertexAttribPointer(aShape, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribPointer(aGlow, 1, gl.FLOAT, false, stride, 32);
    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), this.w, this.h);
    gl.uniform1f(gl.getUniformLocation(p, 'uDpr'), this.dpr);
    gl.uniform1f(gl.getUniformLocation(p, 'uDark'), this.dark ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.count);
    [aPx, aSize, aCol, aShape, aGlow].forEach((a) => gl.disableVertexAttribArray(a));
  }

  private draw2d(yaw: number, pitch: number) {
    const ctx = this.ctx!;
    const { cx, cy, r } = this.placement;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const step = this.dustCount > 1800 ? Math.ceil(this.dustCount / 1800) : 1; // the fallback draws fewer, larger dust points
    for (let i = 0; i < this.dustCount; i += step) {
      const k = Math.max(0, Math.min(1, (this.intro - this.dustSeed[i * 4 + 3] * 0.7) / 0.3));
      if (k <= 0) continue;
      const px = this.dustPos[i * 3] * (0.55 + 0.45 * k), py = this.dustPos[i * 3 + 1] * (0.55 + 0.45 * k), pz = this.dustPos[i * 3 + 2] * (0.55 + 0.45 * k);
      const x1 = cyw * px + syw * pz, z1 = -syw * px + cyw * pz;
      const y2 = cp * py - sp * z1, z2 = sp * py + cp * z1;
      const s = D / (D - z2);
      const depth = (z2 + 1) / 2;
      const a = (0.3 + 0.6 * Math.max(0, Math.min(1, depth))) * 0.9 * k;
      const c = this.dustSeed[i * 4 + 2] < 0.62 ? this.dustColors.main : this.dustColors.accent;
      ctx.fillStyle = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.min(1, a * this.dustColors.boost).toFixed(2)})`;
      const sz = (0.6 + this.dustSeed[i * 4 + 1] * 1.4) * s * (r / 300) * 1.9 * step ** 0.5;
      ctx.fillRect(cx + x1 * r * s - sz / 2, cy - y2 * r * s - sz / 2, sz, sz);
    }
    const nodeAlpha = this.reduced ? 1 : Math.max(0, Math.min(1, (this.intro - 0.45) / 0.45));
    const F = 10;
    for (let n = 0; n < this.count; n++) {
      const i = this.order[n];
      const o = i * F;
      const depth = Math.max(0, Math.min(1, (this.sz[i] + 1.2) / 2.4));
      const al = this.cur[o + 6] * (0.42 + 0.58 * depth) * nodeAlpha;
      if (al <= 0.01) continue;
      const rgb = `${Math.round(this.cur[o + 3] * 255)},${Math.round(this.cur[o + 4] * 255)},${Math.round(this.cur[o + 5] * 255)}`;
      const x = this.sx[i], y = this.sy[i], sz = Math.max(2, this.ss[i]), glow = this.cur[o + 8];
      if (glow > 0.05) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, sz * (1 + glow * 2.6));
        g.addColorStop(0, `rgba(${rgb},${(al * 0.4 * glow).toFixed(2)})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - sz * 4, y - sz * 4, sz * 8, sz * 8);
      }
      ctx.beginPath();
      const shape = this.shapes[i];
      if (shape === 2) {
        ctx.moveTo(x, y - sz * 1.15); ctx.lineTo(x + sz * 1.15, y); ctx.lineTo(x, y + sz * 1.15); ctx.lineTo(x - sz * 1.15, y); ctx.closePath();
        ctx.fillStyle = `rgba(${rgb},${al.toFixed(2)})`;
        ctx.fill();
      } else if (shape === 1) {
        ctx.arc(x, y, sz * 0.72, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.2, sz * 0.26);
        ctx.strokeStyle = `rgba(${rgb},${al.toFixed(2)})`;
        ctx.stroke();
      } else {
        ctx.arc(x, y, sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${al.toFixed(2)})`;
        ctx.fill();
      }
    }
  }

  dispose() {
    const gl = this.gl;
    if (gl) {
      if (this.dustBuf) gl.deleteBuffer(this.dustBuf);
      if (this.nodeBuf) gl.deleteBuffer(this.nodeBuf);
      if (this.dustProg) gl.deleteProgram(this.dustProg);
      if (this.nodeProg) gl.deleteProgram(this.nodeProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.ctx = null;
  }
}
