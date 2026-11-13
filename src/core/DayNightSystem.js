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
      // 夜间 (0..0.25) — 冷蓝，保留夜晚氛围但抬高亮度下限
      const k = t / 0.25;
      sunIntensity = 0.30 + 0.30 * k; ambIntensity = 0.42 + 0.18 * k;
      sunColor = new THREE.Color(0x5a6a9a).lerp(new THREE.Color(0xffb877), k);
      ambColVal = 0x6a7694;
      fogColVal = 0x76839e;
    } else if (t < 0.5) {
      // 清晨 (0.25..0.5) — 暖橙 → 白
      const k = (t - 0.25) / 0.25;
      sunIntensity = 0.75 + 0.70 * k; ambIntensity = 0.60 + 0.14 * k;
      sunColor = new THREE.Color(0xffb877).lerp(new THREE.Color(0xfff6e4), k);
      ambColVal = new THREE.Color(0xa8b6c4).lerp(new THREE.Color(0xd8e0e8), k).getHex();
      fogColVal = new THREE.Color(0xc6d2dc).lerp(new THREE.Color(0xd6e4ef), k).getHex();
    } else if (t < 0.75) {
      // 正午 (0.5..0.75) — 白 → 橙红
      const k = (t - 0.5) / 0.25;
      sunIntensity = 1.45 - 0.60 * k; ambIntensity = 0.74 - 0.18 * k;
      sunColor = new THREE.Color(0xfff6e4).lerp(new THREE.Color(0xff9455), k);
      ambColVal = new THREE.Color(0xd8e0e8).lerp(new THREE.Color(0xb08a76), k).getHex();
      fogColVal = new THREE.Color(0xd6e4ef).lerp(new THREE.Color(0xe8bfa0), k).getHex();
    } else {
      // 黄昏 (0.75..1.0) — 橙红 → 冷蓝
      const k = (t - 0.75) / 0.25;
      sunIntensity = 0.85 - 0.55 * k; ambIntensity = 0.56 - 0.14 * k;
      sunColor = new THREE.Color(0xff9455).lerp(new THREE.Color(0x5a6a9a), k);
      ambColVal = new THREE.Color(0xb08a76).lerp(new THREE.Color(0x6a7694), k).getHex();
      fogColVal = new THREE.Color(0xe8bfa0).lerp(new THREE.Color(0x76839e), k).getHex();
    }

    // 天气叠加（阴天/雨天只做轻微压暗，不再把场景打成昏暗）
    if (s.weather === 'fog') {
      sunIntensity *= 0.72; ambIntensity *= 0.90;
      fogColVal = new THREE.Color(fogColVal).lerp(new THREE.Color(0xc3ccd6), 0.35).getHex();
      this.fog.near = 24; this.fog.far = 105;
    } else if (s.weather === 'rain') {
      sunIntensity *= 0.82; ambIntensity *= 0.90;
      fogColVal = new THREE.Color(fogColVal).lerp(new THREE.Color(0x8a94a4), 0.35).getHex();
      this.fog.near = 34; this.fog.far = 150;
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

  /** 重置（新局开始）：从明亮的上午开始，避免一进局就是昏暗清晨 */
  reset() {
    this.state.time = 0.46;
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
