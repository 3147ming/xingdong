/**
 * 轻量后期处理（不依赖 Three.js 官方 addons）
 *
 * 流程：
 *  1. 场景渲染到全分辨率 RenderTarget（线性色彩空间，HalfFloat）
 *  2. 亮度提取：超过阈值的像素进入半分辨率亮部纹理
 *  3. 两轮可分离高斯模糊（水平 / 垂直各两遍）
 *  4. 合成：基础画面 + 辉光 + 暗角 + 受击边缘闪红，最后做 sRGB 编码输出
 *
 * 对外：render / setSize / update / setDamage
 */
import * as THREE from 'three';

const QUAD_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = `
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float softness;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float k = smoothstep(threshold, threshold + softness, l);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const BLUR_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 direction;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227;
  sum += (texture2D(tDiffuse, vUv + direction).rgb + texture2D(tDiffuse, vUv - direction).rgb) * 0.194;
  sum += (texture2D(tDiffuse, vUv + direction * 2.0).rgb + texture2D(tDiffuse, vUv - direction * 2.0).rgb) * 0.121;
  sum += (texture2D(tDiffuse, vUv + direction * 3.0).rgb + texture2D(tDiffuse, vUv - direction * 3.0).rgb) * 0.054;
  sum += (texture2D(tDiffuse, vUv + direction * 4.0).rgb + texture2D(tDiffuse, vUv - direction * 4.0).rgb) * 0.016;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = `
uniform sampler2D tBase;
uniform sampler2D tBloom;
uniform float strength;
uniform float vignette;
uniform float damage;
uniform vec2 resolution;
varying vec2 vUv;
void main() {
  vec3 base = texture2D(tBase, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 col = base + bloom * strength;

  vec2 p = vUv - 0.5;
  float r = length(p * vec2(resolution.x / resolution.y, 1.0));
  col *= 1.0 - smoothstep(0.55, 1.15, r) * vignette;

  // 受击：屏幕边缘闪红
  float edge = smoothstep(0.42, 1.0, r);
  col += vec3(0.55, 0.04, 0.02) * edge * damage;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.strength = 0.75;
    this.threshold = 0.68;
    this.vignette = 0.55;
    this.damage = 0;
    this.enabled = true;

    this._size = new THREE.Vector2(1, 1);
    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    this._brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        threshold: { value: this.threshold },
        softness: { value: 0.28 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        direction: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._compMat = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: null },
        tBloom: { value: null },
        strength: { value: this.strength },
        vignette: { value: this.vignette },
        damage: { value: 0 },
        resolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._targets = [];
    this.setSize(renderer.domElement.width || 1, renderer.domElement.height || 1);
  }

  /** 按绘制缓冲尺寸重建全部渲染目标 */
  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this._size.x && h === this._size.y && this.sceneTarget) return;
    this._size.set(w, h);

    this._disposeTargets();

    const halfW = Math.max(1, Math.floor(w / 2));
    const halfH = Math.max(1, Math.floor(h / 2));

    this.sceneTarget = this._makeTarget(w, h);
    this.brightTarget = this._makeTarget(halfW, halfH);
    this.blurA = this._makeTarget(halfW, halfH);
    this.blurB = this._makeTarget(halfW, halfH);

    this._compMat.uniforms.resolution.value.set(w, h);
    this._blurMat.uniforms.direction.value.set(1 / halfW, 0);
  }

  _makeTarget(w, h) {
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this._targets.push(target);
    return target;
  }

  _disposeTargets() {
    for (const t of this._targets) t.dispose();
    this._targets.length = 0;
  }

  /** 受击闪红（1 = 最强，自动衰减） */
  setDamage(v) {
    this.damage = Math.max(this.damage, Math.max(0, Math.min(1, Number(v) || 0)));
  }

  update(dt) {
    if (this.damage > 0) this.damage = Math.max(0, this.damage - dt * 2.4);
  }

  /** 运行一帧后期处理 */
  render(scene, camera) {
    const renderer = this.renderer;
    if (!this.enabled || !this.sceneTarget) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    // 1. 场景 → 全分辨率目标
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // 2. 亮度提取
    this._quad.material = this._brightMat;
    this._brightMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this._brightMat.uniforms.threshold.value = this.threshold;
    renderer.setRenderTarget(this.brightTarget);
    renderer.render(this._quadScene, this._quadCamera);

    // 3. 两轮可分离高斯模糊
    this._quad.material = this._blurMat;
    const halfW = this.brightTarget.width;
    const halfH = this.brightTarget.height;
    let src = this.brightTarget;
    for (let i = 0; i < 2; i++) {
      this._blurMat.uniforms.tDiffuse.value = src.texture;
      this._blurMat.uniforms.direction.value.set((1 + i) / halfW, 0);
      renderer.setRenderTarget(this.blurA);
      renderer.render(this._quadScene, this._quadCamera);
      src = this.blurA;

      this._blurMat.uniforms.tDiffuse.value = src.texture;
      this._blurMat.uniforms.direction.value.set(0, (1 + i) / halfH);
      renderer.setRenderTarget(this.blurB);
      renderer.render(this._quadScene, this._quadCamera);
      src = this.blurB;
    }

    // 4. 合成到画布
    this._quad.material = this._compMat;
    this._compMat.uniforms.tBase.value = this.sceneTarget.texture;
    this._compMat.uniforms.tBloom.value = src.texture;
    this._compMat.uniforms.strength.value = this.strength;
    this._compMat.uniforms.vignette.value = this.vignette;
    this._compMat.uniforms.damage.value = this.damage;
    renderer.setRenderTarget(null);
    renderer.render(this._quadScene, this._quadCamera);
  }
}
