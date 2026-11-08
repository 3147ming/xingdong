/**
 * 昼夜循环 + 天气系统
 *
 * 设计原则：Three.js 灯光对象通过**外部别名引用**（Game._dnSun / Game._dnAmbient）访问，
 * 不修改 Game 构造函数里 `const ambient` / `const dirLight` 的原始声明 — 避免破坏 three.js
 * 内部对对象生命周期的跟踪。
 *
 * 昼夜：4 段分段 lerp 颜色曲线（夜→晨→午→昏→夜），控制 sun 强度/色温 + ambient 强度/色温 + fog 颜色。
 * 天气：clear / fog / rain 三态，随机切换，影响 fog near/far + 整体亮度。
 */
import * as THREE from 'three';

const TWO_PI = Math.PI * 2;

export class DayNightSystem {
  /**
   * @param {Object} state        Game._dnState
   * @param {THREE.DirectionalLight} sun   外部别名引用
   * @param {THREE.AmbientLight} amb      外部别名引用
   * @param {THREE.Fog} fog               this.scene.fog
   * @param {THREE.Color} bg              this.scene.background
   */
  constructor({ state, sun, amb, fog, bg }) {
    this.state = state;
    this.sun = sun;
    this.amb = amb;
    this.fog = fog;
    this.bg = bg;
  }

  /** 每帧推进 + 应用光照。state 由 Game 持有，这里不修改。 */
  update(dt, playing) {
    const s = this.state;
    if (playing) {
      // 推进时间（dayLength 秒 = 一昼夜）
      s.time = (s.time + dt / s.dayLength) % 1;
      // 天气随机切换（每 60-120 秒）
      s.nextWeatherAt -= dt;
      if (s.nextWeatherAt <= 0) {
        const r = Math.random();
        s.weather = r < 0.55 ? 'clear' : (r < 0.8 ? 'fog' : 'rain');
        s.nextWeatherAt = 60 + Math.random() * 60;
      }
    }

    const t = s.time;

    // 太阳角度：t=0.25 日出，t=0.75 日落
    const sunAngle = (t - 0.25) * TWO_PI;
    const sunHeightNorm = Math.max(0, Math.sin(sunAngle));
    const sunX = Math.cos(sunAngle);
    // 位置：绕 Y 轴公转
    this.sun.position.set(sunX * 50, sunHeightNorm * 50 + 3, 15);
    this.sun.position.normalize().multiplyScalar(55);

    // 4 段分段 lerp
    let sunColor, sunIntensity, ambIntensity, fogColVal, ambColVal;
    if (t < 0.25) {
      // 夜间 (0..0.25) — 冷蓝
      const k = t / 0.25;
      sunIntensity = 0.08 + 0.22 * k; ambIntensity = 0.18 + 0.14 * k;
      sunColor = new THREE.Color(0x3a4a7a).lerp(new THREE.Color(0xffaa66), k);
      ambColVal = 0x3c4868;
      fogColVal = 0x4a5470;
    } else if (t < 0.5) {
      // 清晨 (0.25..0.5) — 暖橙 → 白
      const k = (t - 0.25) / 0.25;
      sunIntensity = 0.30 + 0.60 * k; ambIntensity = 0.32 + 0.12 * k;
      sunColor = new THREE.Color(0xffaa66).lerp(new THREE.Color(0xfff4d8), k);
      ambColVal = new THREE.Color(0x8899aa).lerp(new THREE.Color(0xc8d0d8), k).getHex();
      fogColVal = new THREE.Color(0xa8b4c0).lerp(new THREE.Color(0xb9c9d6), k).getHex();
    } else if (t < 0.75) {
      // 正午 (0.5..0.75) — 白 → 橙红
      const k = (t - 0.5) / 0.25;
      sunIntensity = 0.90 - 0.55 * k; ambIntensity = 0.44 - 0.18 * k;
      sunColor = new THREE.Color(0xfff4d8).lerp(new THREE.Color(0xff7a3a), k);
      ambColVal = new THREE.Color(0xc8d0d8).lerp(new THREE.Color(0x886655), k).getHex();
      fogColVal = new THREE.Color(0xb9c9d6).lerp(new THREE.Color(0xd0a080), k).getHex();
    } else {
      // 黄昏 (0.75..1.0) — 橙红 → 冷蓝
      const k = (t - 0.75) / 0.25;
      sunIntensity = 0.35 - 0.27 * k; ambIntensity = 0.26 - 0.08 * k;
      sunColor = new THREE.Color(0xff7a3a).lerp(new THREE.Color(0x3a4a7a), k);
      ambColVal = new THREE.Color(0x886655).lerp(new THREE.Color(0x3c4868), k).getHex();
      fogColVal = new THREE.Color(0xd0a080).lerp(new THREE.Color(0x4a5470), k).getHex();
    }

    // 天气叠加
    if (s.weather === 'fog') {
      sunIntensity *= 0.55; ambIntensity *= 0.80;
      fogColVal = new THREE.Color(fogColVal).lerp(new THREE.Color(0x9aa5b0), 0.35).getHex();
      this.fog.near = 18; this.fog.far = 85;
    } else if (s.weather === 'rain') {
      sunIntensity *= 0.65; ambIntensity *= 0.80;
      fogColVal = new THREE.Color(fogColVal).lerp(new THREE.Color(0x485060), 0.40).getHex();
      this.fog.near = 30; this.fog.far = 135;
    } else {
      this.fog.near = s.fogNear0; this.fog.far = s.fogFar0;
    }

    // 应用到 three.js 对象
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunIntensity;
    this.amb.color.setHex(ambColVal);
    this.amb.intensity = ambIntensity;
    this.fog.color.setHex(fogColVal);
    this.bg.copy(this.fog.color);
  }

  /** 重置（新局开始） */
  reset() {
    this.state.time = 0.40;
    this.state.weather = 'clear';
    this.state.nextWeatherAt = 45;
  }

  /** 人类可读状态（UI / Debug 用） */
  describe() {
    const s = this.state;
    const period =
      s.time < 0.25 ? '🌙 深夜' :
      s.time < 0.50 ? '🌅 清晨' :
      s.time < 0.75 ? '☀️ 正午' : '🌆 黄昏';
    const w = s.weather === 'fog' ? '雾' : s.weather === 'rain' ? '雨' : '晴';
    const timeStr = `${Math.floor(s.time * 24).toString().padStart(2, '0')}:00`;
    return `${period} ${timeStr} · ${w}`;
  }
}
