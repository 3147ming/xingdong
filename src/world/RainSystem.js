/**
 * 降雨系统：GPU 点精灵雨幕（跟随相机的循环雨盒，零 CPU 逐帧更新）
 *
 * 参考《几猫》港区雨夜的做法：
 *  - 雨滴用细长条纹而不是圆点，远看是一层雨幕而不是"白点"
 *  - 雨盒始终以相机为中心循环包裹，玩家走到哪里都下雨
 *  - 开关通过整体透明度淡入淡出，配合天气系统切换
 */
import * as THREE from 'three';

const VERT = `
uniform float uTime;
uniform vec3 uOrigin;
uniform float uOpacity;
attribute float aSpeed;
attribute float aSize;
varying float vAlpha;
void main() {
  float H = 34.0;
  float y = mod(position.y - uTime * aSpeed, H);
  vec3 world = vec3(
    uOrigin.x + position.x,
    uOrigin.y + y - H * 0.35,
    uOrigin.z + position.z
  );
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * (360.0 / max(1.0, -mv.z));
  // 太近的雨滴淡化，避免糊在镜头上
  float nearFade = smoothstep(0.6, 4.0, -mv.z);
  vAlpha = uOpacity * nearFade * 0.55;
}
`;

const FRAG = `
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  // 细长竖条纹：横向快速衰减，纵向保持
  float streak = smoothstep(0.50, 0.05, abs(uv.x) * 7.0) * smoothstep(0.5, 0.08, abs(uv.y));
  float a = streak * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(0.72, 0.80, 0.92, a);
}
`;

export class RainSystem {
  constructor(scene, count = 2600) {
    this.opacity = 0;
    this.target = 0;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    const size = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // 以相机为中心的循环雨盒：XZ ±35，Y 0..34
      pos[i * 3] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 1] = Math.random() * 34;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 70;
      speed[i] = 22 + Math.random() * 14;
      size[i] = 8 + Math.random() * 10;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uOpacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    scene.add(this.points);
  }

  /** 天气切换：true = 下雨 */
  setEnabled(on) {
    this.target = on ? 1 : 0;
  }

  update(dt, cameraPos) {
    const diff = this.target - this.opacity;
    if (Math.abs(diff) > 0.001) {
      this.opacity += Math.sign(diff) * Math.min(Math.abs(diff), dt * 0.8);
    }
    this.points.visible = this.opacity > 0.01;
    if (!this.points.visible) return;
    this.material.uniforms.uOpacity.value = this.opacity;
    this.material.uniforms.uTime.value += dt;
    if (cameraPos) this.material.uniforms.uOrigin.value.copy(cameraPos);
  }
}
