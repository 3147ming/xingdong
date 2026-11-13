/**
 * 后期处理（参考作的分层思路，不依赖 Three.js 官方 addons）
 *
 * 流程：
 *  1. 场景 → 全分辨率 HalfFloat RenderTarget（线性 HDR，带深度纹理）
 *  2. SSAO：半分辨率，由深度重建视空间位置 + 屏幕导数求法线，半球采样求遮蔽
 *  3. SSAO 可分离高斯模糊（水平 / 垂直各一遍）
 *  4. 亮度提取 → 两轮可分离高斯模糊（Bloom）
 *  5. 合成：基础画面 × AO + 辉光 + 暗角 + 受击边缘闪红，
 *     最后统一做 ACES 色调映射与 sRGB 编码
 *
 * 为什么色调映射放在最后：场景渲染到 RT 时 Three.js 不会应用色调映射
 * （r160 只在渲染到屏幕时注入），所以必须自己在合成阶段压高光。
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

const AO_FRAG = `
uniform sampler2D tDepth;
uniform mat4 projectionMat;
uniform mat4 inverseProjectionMatrix;
uniform float radius;
uniform float intensity;
uniform float bias;
varying vec2 vUv;

vec3 viewPosition(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = inverseProjectionMatrix * clip;
  return view.xyz / view.w;
}

void main() {
  float depth = texture2D(tDepth, vUv).x;
  // 天空 / 背景不参与 AO
  if (depth >= 0.99999) { gl_FragColor = vec4(1.0); return; }

  vec3 p = viewPosition(vUv, depth);
  // 用屏幕空间导数求视空间法线（不需要法线 G-Buffer）
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  // 保证法线朝向相机（相机在原点、看向 -Z）
  if (dot(n, normalize(-p)) < 0.0) n = -n;

  // 构造切线基
  vec3 helper = abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = normalize(cross(helper, n));
  vec3 b = cross(n, t);

  const int SAMPLES = 12;
  float occluded = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float fi = float(i);
    float ang = fi * 2.39996323;                    // 黄金角螺旋
    float r = sqrt((fi + 0.5) / float(SAMPLES)) * radius;
    float lift = 0.25 + 0.75 * fract(fi * 0.6180339);  // 半球内的抬升
    vec3 dir = normalize(t * cos(ang) + b * sin(ang) + n * lift);
    vec3 sp = p + dir * r;

    vec4 clip = projectionMat * vec4(sp, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = texture2D(tDepth, suv).x;
    if (sd >= 0.99999) continue;
    vec3 sv = viewPosition(suv, sd);
    // 采样点比当前表面更靠近相机 → 被遮挡
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(1e-4, abs(p.z - sv.z)));
    if (sv.z >= sp.z + bias) occluded += rangeCheck;
  }

  float ao = 1.0 - (occluded / float(SAMPLES)) * intensity;
  gl_FragColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
}
`;

const COMPOSITE_FRAG = `
uniform sampler2D tBase;
uniform sampler2D tBloom;
uniform sampler2D tAO;
uniform float strength;
uniform float vignette;
uniform float damage;
uniform float aoStrength;
uniform float exposure;
uniform vec2 resolution;
varying vec2 vUv;

/** ACES Filmic 近似（Narkowicz），把线性 HDR 压回 0..1 */
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 base = texture2D(tBase, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 col = base + bloom * strength;

  // 环境光遮蔽：只压暗缝隙与接触处
  float ao = texture2D(tAO, vUv).r;
  col *= mix(1.0, ao, aoStrength);

  col *= exposure;
  col = acesFilmic(col);

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
    this.threshold = 1.18;    // HDR 线性空间的亮度阈值（开启色调映射后要抬高）
    this.vignette = 0.26;     // 暗角收轻：不再压暗四周画面
    this.damage = 0;
    this.enabled = true;

    this.aoEnabled = true;
    this.aoStrength = 0.55;   // 遮蔽只做接触阴影，避免整体发灰发暗
    this.aoRadius = 0.55;
    this.aoIntensity = 1.0;
    this.aoBias = 0.022;

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
        softness: { value: 0.35 },
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

    this._aoMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        projectionMat: { value: new THREE.Matrix4() },
        inverseProjectionMatrix: { value: new THREE.Matrix4() },
        radius: { value: this.aoRadius },
        intensity: { value: this.aoIntensity },
        bias: { value: this.aoBias },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: AO_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._compMat = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: null },
        tBloom: { value: null },
        tAO: { value: null },
        strength: { value: this.strength },
        vignette: { value: this.vignette },
        damage: { value: 0 },
        aoStrength: { value: this.aoStrength },
        exposure: { value: renderer.toneMappingExposure || 1 },
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
    const quarterW = Math.max(1, Math.floor(w / 4));
    const quarterH = Math.max(1, Math.floor(h / 4));

    // 场景主目标：需要深度纹理给 SSAO 用
    this.sceneTarget = this._makeTarget(w, h, true);
    this.aoTarget = this._makeTarget(halfW, halfH);
    this.aoBlurA = this._makeTarget(halfW, halfH);
    this.aoBlurB = this._makeTarget(halfW, halfH);
    this.brightTarget = this._makeTarget(quarterW, quarterH);
    this.blurA = this._makeTarget(quarterW, quarterH);
    this.blurB = this._makeTarget(quarterW, quarterH);

    this._compMat.uniforms.resolution.value.set(w, h);
    this._blurMat.uniforms.direction.value.set(1 / halfW, 0);
  }

  _makeTarget(w, h, withDepth = false) {
    const opts = {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    };
    if (withDepth) {
      const depth = new THREE.DepthTexture(w, h);
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      this._depthTexture = depth;
      opts.depthTexture = depth;
    }
    const target = new THREE.WebGLRenderTarget(w, h, opts);
    this._targets.push(target);
    return target;
  }

  _disposeTargets() {
    for (const t of this._targets) t.dispose();
    this._targets.length = 0;
    if (this._depthTexture) {
      this._depthTexture.dispose();
      this._depthTexture = null;
    }
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

    // 1. 场景 → 全分辨率目标（带深度）
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // 2. SSAO（半分辨率）
    if (this.aoEnabled) {
      const ao = this._aoMat.uniforms;
      ao.tDepth.value = this.sceneTarget.depthTexture;
      ao.projectionMat.value.copy(camera.projectionMatrix);
      ao.inverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
      ao.radius.value = this.aoRadius;
      ao.intensity.value = this.aoIntensity;
      ao.bias.value = this.aoBias;
      this._quad.material = this._aoMat;
      renderer.setRenderTarget(this.aoTarget);
      renderer.render(this._quadScene, this._quadCamera);

      // 3. 模糊 AO，避免噪点
      const halfW = this.aoTarget.width;
      const halfH = this.aoTarget.height;
      this._quad.material = this._blurMat;
      this._blurMat.uniforms.tDiffuse.value = this.aoTarget.texture;
      this._blurMat.uniforms.direction.value.set(1 / halfW, 0);
      renderer.setRenderTarget(this.aoBlurA);
      renderer.render(this._quadScene, this._quadCamera);
      this._blurMat.uniforms.tDiffuse.value = this.aoBlurA.texture;
      this._blurMat.uniforms.direction.value.set(0, 1 / halfH);
      renderer.setRenderTarget(this.aoBlurB);
      renderer.render(this._quadScene, this._quadCamera);
    }

    // 4. 亮度提取
    this._quad.material = this._brightMat;
    this._brightMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this._brightMat.uniforms.threshold.value = this.threshold;
    renderer.setRenderTarget(this.brightTarget);
    renderer.render(this._quadScene, this._quadCamera);

    // 5. 两轮可分离高斯模糊
    this._quad.material = this._blurMat;
    const bw = this.brightTarget.width;
    const bh = this.brightTarget.height;
    let src = this.brightTarget;
    for (let i = 0; i < 2; i++) {
      this._blurMat.uniforms.tDiffuse.value = src.texture;
      this._blurMat.uniforms.direction.value.set((1 + i) / bw, 0);
      renderer.setRenderTarget(this.blurA);
      renderer.render(this._quadScene, this._quadCamera);
      src = this.blurA;

      this._blurMat.uniforms.tDiffuse.value = src.texture;
      this._blurMat.uniforms.direction.value.set(0, (1 + i) / bh);
      renderer.setRenderTarget(this.blurB);
      renderer.render(this._quadScene, this._quadCamera);
      src = this.blurB;
    }

    // 6. 合成到画布
    this._quad.material = this._compMat;
    const c = this._compMat.uniforms;
    c.tBase.value = this.sceneTarget.texture;
    c.tBloom.value = src.texture;
    c.tAO.value = this.aoEnabled ? this.aoBlurB.texture : null;
    c.strength.value = this.strength;
    c.vignette.value = this.vignette;
    c.damage.value = this.damage;
    c.aoStrength.value = this.aoEnabled ? this.aoStrength : 0;
    c.exposure.value = renderer.toneMappingExposure || 1;
    renderer.setRenderTarget(null);
    renderer.render(this._quadScene, this._quadCamera);
  }
}
