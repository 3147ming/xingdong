/**
 * 音频管理器（WebAudio）
 *
 * 参考作的分层思路：素材音 + 合成音，统一走 5 条总线再进主输出，
 * 总线后面挂「程序化 IR 卷积混响」，空间音用 PannerNode 做距离衰减与左右定位。
 *
 *   世界音 → world ┐
 *   近身音 → near  ├→ 主链路（压缩器 → 软削波 → 输出）
 *   环境音 → amb   │
 *   干声   → dry   │
 *   音乐   → music ┘
 *   各总线按比例送一份到卷积混响（室外 / 铁皮棚两种 IR）
 *
 * 对外 API 与旧版保持兼容：play / createLoop / playSfx / playGrowl /
 * distanceVolume / setMasterVolume / start*Music / startAmbience / update。
 * 新增：playImpact(surface, position) —— 按命中材质播放合成撞击音。
 */
import * as THREE from 'three';

const AUDIO_DIR = './public/assets/audio/';

const FILES = {
  fire1: 'fire_01.mp3',
  fire2: 'fire_02.mp3',
  fireEmpty: 'fire_empty.mp3',
  reload: 'reload.mp3',
  reloadEmpty: 'reload_empty.mp3',
  casing1: 'casing_1.mp3',
  casing2: 'casing_2.mp3',
  casing3: 'casing_3.mp3',
  casing4: 'casing_4.mp3',
  casing5: 'casing_5.mp3',
  walkLoop: 'walk_loop.mp3',
  runLoop: 'run_loop.mp3',
  hit: 'hit.mp3',
  land: 'land.mp3',
  hurt: 'hurt.mp3',
  kill: 'kill.mp3',
};

/**
 * 同名音效最小播放间隔（秒），避免连发时同一音效叠加产生爆音
 */
const MIN_INTERVAL = {
  hit: 0.04,
  kill: 0.10,
  hurt: 0.22,
  land: 0.12,
  fire1: 0.03,
  fire2: 0.03,
  fireEmpty: 0.08,
  reload: 0.15,
};

/** 音效 → 总线：枪声贴身、抛壳在空间里、受伤与 UI 走干声 */
const BUS_BY_SOUND = {
  fire1: 'near',
  fire2: 'near',
  fireEmpty: 'near',
  reload: 'near',
  reloadEmpty: 'near',
  hit: 'near',
  kill: 'near',
  land: 'near',
  walkLoop: 'near',
  runLoop: 'near',
  casing1: 'world',
  casing2: 'world',
  casing3: 'world',
  casing4: 'world',
  casing5: 'world',
};

/** 各总线送进卷积混响的比例 */
const BUS_SEND = {
  world: 0.55,
  near: 0.22,
  amb: 0.30,
  dry: 0.05,
  music: 0.35,
};

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.enabled = true;
    this.volume = 1.0;       // 主音量（设置界面可调）
    this.master = null;      // 总音量节点
    this.buses = null;       // 5 条总线
    this.reverb = null;      // 卷积混响节点
    this._lastPlay = {};     // 同名音效上次播放时间，防叠加爆音

    // 合成音源（BGM / 环境音 / 嘶吼），不依赖任何外部素材
    this.music = null;
    this.ambience = null;
    this._intensity = 0;
    this._pulseTimer = 0;
    this._crowTimer = 0;
    this._time = 0;
    this._noise = null;
    this._impacts = {};      // 材质化撞击音缓存
    this._space = 'outdoor';

    this._tmpPos = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpFwd = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3();
  }

  /** 初始化音频上下文、主链路、总线与混响，并解码全部音效 */
  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[Audio] 当前浏览器不支持 WebAudio');
      return;
    }
    this.ctx = new Ctx();
    this._buildGraph();
    this._impacts = {
      metal: this._synthImpact('metal'),
      concrete: this._synthImpact('concrete'),
      wood: this._synthImpact('wood'),
      glass: this._synthImpact('glass'),
    };
    const entries = Object.entries(FILES);
    await Promise.all(
      entries.map(async ([name, file]) => {
        try {
          const res = await fetch(AUDIO_DIR + file);
          const buf = await res.arrayBuffer();
          this.buffers[name] = await this.ctx.decodeAudioData(buf);
        } catch (err) {
          console.warn('[Audio] 音效加载失败:', name, err);
        }
      })
    );
  }

  /**
   * 主链路：master → 压缩器 → 软削波（waveshaper）→ 输出
   * 软削波让连射叠加时不至于硬爆音，同时把整体响度提一点。
   */
  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.14;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = Math.sign(x) * (a <= 0.6 ? a : 0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4));
    }
    shaper.curve = curve;
    try { shaper.oversample = '2x'; } catch (e) { /* 老浏览器忽略 */ }

    this.master.connect(comp);
    comp.connect(shaper);
    shaper.connect(ctx.destination);

    // 5 条总线
    this.buses = {};
    for (const name of ['world', 'near', 'amb', 'dry', 'music']) {
      const g = ctx.createGain();
      g.gain.value = name === 'amb' ? 0.75 : 1.0;
      g.connect(this.master);
      this.buses[name] = g;
    }

    // 卷积混响：程序化 IR，无外部素材
    try {
      this.reverb = {
        input: ctx.createGain(),
        conv: ctx.createConvolver(),
        out: ctx.createGain(),
        buffers: {
          outdoor: this._makeIR(0.55, 2.6, 0.55),
          shed: this._makeIR(0.95, 1.9, 0.32),
        },
      };
      this.reverb.input.gain.value = 1;
      this.reverb.out.gain.value = 0.55;
      this.reverb.out.connect(this.master);
      this.reverb.conv.connect(this.reverb.out);
      this.reverb.conv.buffer = this.reverb.buffers[this._space];
      this.reverb.input.connect(this.reverb.conv);
      // 各总线按比例送混响
      for (const [name, amount] of Object.entries(BUS_SEND)) {
        if (!this.buses[name]) continue;
        const send = ctx.createGain();
        send.gain.value = amount;
        this.buses[name].connect(send);
        send.connect(this.reverb.input);
      }
    } catch (e) {
      // 混响不可用时保持干声，不影响其它音效
      this.reverb = null;
    }
  }

  /** 程序化脉冲响应：噪声 + 指数衰减 + 几个早期反射抽头 */
  _makeIR(seconds, decay, bright) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.round(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(Math.max(0, 1 - t), decay);
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * (0.10 + bright * 0.45);   // 一阶低通，越亮截止越高
        d[i] = lp * env * 0.55;
      }
      // 离散早期反射，给空间一点方向感
      const taps = ch ? [[0.013, 0.35], [0.023, -0.24], [0.037, 0.18]]
        : [[0.011, 0.4], [0.019, 0.28], [0.031, -0.2]];
      for (const [time, gain] of taps) {
        const idx = Math.floor(time * rate);
        if (idx < len) d[idx] += gain;
      }
    }
    return buf;
  }

  /** 合成材质化撞击音（金属 / 混凝土 / 木头 / 玻璃） */
  _synthImpact(surface) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const dur = surface === 'metal' ? 0.26 : surface === 'glass' ? 0.30 : 0.20;
    const len = Math.max(1, Math.round(rate * dur));
    const buf = ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    let lp = 0;
    const TAU = Math.PI * 2;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const n = Math.random() * 2 - 1;
      let v = 0;
      if (surface === 'metal') {
        // 高频脆响 + 三个金属共振峰
        v = n * 0.45 * Math.exp(-t * 70)
          + Math.sin(TAU * 2380 * t) * 0.30 * Math.exp(-t * 28)
          + Math.sin(TAU * 3710 * t) * 0.22 * Math.exp(-t * 34)
          + Math.sin(TAU * 5140 * t) * 0.13 * Math.exp(-t * 42);
      } else if (surface === 'wood') {
        lp += (n - lp) * 0.25;
        v = lp * 0.95 * Math.exp(-t * 40)
          + Math.sin(TAU * 205 * t) * 0.42 * Math.exp(-t * 42)
          + Math.sin(TAU * 412 * t) * 0.16 * Math.exp(-t * 52);
      } else if (surface === 'glass') {
        // 高频碎裂 + 几颗随机玻璃渣
        const tink = Math.sin(TAU * (4200 + Math.floor(t * 900) % 5 * 640) * t);
        v = n * 0.34 * Math.exp(-t * 46)
          + Math.sin(TAU * 4380 * t) * 0.18 * Math.exp(-t * 22)
          + tink * 0.10 * Math.exp(-t * 18);
      } else {
        // 混凝土：低通噪声闷响 + 低频撞击 + 粉尘尾音
        lp += (n - lp) * 0.11;
        v = lp * 1.15 * Math.exp(-t * 32)
          + Math.sin(TAU * 138 * t) * 0.34 * Math.exp(-t * 26)
          + n * 0.10 * Math.exp(-t * 11);
      }
      // 8 个采样的淡入，消除起音爆点
      const fade = Math.min(1, i / 8);
      d[i] = Math.max(-1, Math.min(1, v * 0.85)) * fade;
    }
    return buf;
  }

  /** 用户手势后恢复音频上下文 */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * 播放一次性音效
   * @param {string} name 音效名
   * @param {{volume?:number, rate?:number, pos?:THREE.Vector3}} opts
   */
  play(name, opts = {}) {
    const buf = this.buffers[name];
    if (!this.ctx || !buf || !this.enabled) return;
    // 同名音效限流，避免高速连续射击/连续受击时叠爆
    const now = this.ctx.currentTime;
    const gap = MIN_INTERVAL[name] || 0;
    if (gap && this._lastPlay[name] !== undefined && now - this._lastPlay[name] < gap) return;
    this._lastPlay[name] = now;

    const { volume = 1, rate = 1, pos = null } = opts;
    this._emit(buf, {
      volume,
      rate,
      pos,
      bus: pos ? 'world' : (BUS_BY_SOUND[name] || 'near'),
    });
  }

  /**
   * 材质化命中音（合成，不需要素材）
   * @param {'metal'|'concrete'|'wood'|'glass'} surface
   * @param {THREE.Vector3} [position] 命中点（传了就走空间声）
   */
  playImpact(surface, position = null) {
    if (!this.ctx || !this.enabled) return;
    // 霰弹一次 8 颗弹丸会同时命中：限流，避免 8 层撞击音叠成爆音
    const now = this.ctx.currentTime;
    if (now - (this._lastImpact || 0) < 0.03) return;
    this._lastImpact = now;
    const buf = this._impacts[surface] || this._impacts.concrete;
    if (!buf) return;
    this._emit(buf, {
      volume: surface === 'glass' ? 0.32 : 0.42,
      rate: 0.9 + Math.random() * 0.2,
      pos: position,
      bus: 'near',
    });
  }

  /** 统一的播放出口：增益 + 可选 Panner + 总线 */
  _emit(buffer, { volume = 1, rate = 1, pos = null, bus = 'near', delay = 0 } = {}) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.max(0.25, Math.min(4, rate));

    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, volume);
    src.connect(gain);

    if (pos && this.buses && this.buses.world) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';   // 比 HRTF 便宜，连射时不炸 CPU
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.rolloffFactor = 0.7;
      panner.maxDistance = 90;
      this._setPannerPos(panner, pos);
      gain.connect(panner);
      panner.connect(this.buses.world);
      src.onended = () => {
        try { src.disconnect(); gain.disconnect(); panner.disconnect(); } catch (e) { /* 已断开 */ }
      };
    } else {
      gain.connect((this.buses && this.buses[bus]) || this.master);
      src.onended = () => {
        try { src.disconnect(); gain.disconnect(); } catch (e) { /* 已断开 */ }
      };
    }
    src.start(t0);
  }

  _setPannerPos(panner, pos) {
    if (panner.positionX) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  /**
   * 每帧同步听者位置/朝向（相机）。没有它，Panner 只能算左右，
   * 前后与距离都会失准。
   */
  setListener(camera) {
    if (!this.ctx || !camera) return;
    const listener = this.ctx.listener;
    camera.getWorldPosition(this._tmpPos);
    camera.getWorldQuaternion(this._tmpQuat);
    this._tmpFwd.set(0, 0, -1).applyQuaternion(this._tmpQuat);
    this._tmpUp.set(0, 1, 0).applyQuaternion(this._tmpQuat);
    if (listener.positionX) {
      listener.positionX.value = this._tmpPos.x;
      listener.positionY.value = this._tmpPos.y;
      listener.positionZ.value = this._tmpPos.z;
      listener.forwardX.value = this._tmpFwd.x;
      listener.forwardY.value = this._tmpFwd.y;
      listener.forwardZ.value = this._tmpFwd.z;
      listener.upX.value = this._tmpUp.x;
      listener.upY.value = this._tmpUp.y;
      listener.upZ.value = this._tmpUp.z;
    } else {
      listener.setPosition(this._tmpPos.x, this._tmpPos.y, this._tmpPos.z);
      listener.setOrientation(
        this._tmpFwd.x, this._tmpFwd.y, this._tmpFwd.z,
        this._tmpUp.x, this._tmpUp.y, this._tmpUp.z
      );
    }
  }

  /** 切换混响空间（'outdoor' 室外 / 'shed' 铁皮棚内） */
  setSpace(space) {
    if (!this.reverb || !this.reverb.buffers) return;
    const key = this.reverb.buffers[space] ? space : 'outdoor';
    if (key === this._space) return;
    this._space = key;
    try { this.reverb.conv.buffer = this.reverb.buffers[key]; } catch (e) { /* 忽略 */ }
  }

  /** 设置主音量（0~1） */
  setMasterVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.master) this.master.gain.value = this.volume;
  }

  /**
   * 创建持续循环音（脚步）
   * @returns {{setVolume:Function, setRate:Function, stop:Function}}
   */
  createLoop(name, volume = 0) {
    if (!this.ctx || !this.buffers[name]) {
      return { setVolume() {}, setRate() {}, stop() {} };
    }
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = this.buffers[name];
    src.loop = true;
    gain.gain.value = 0;
    src.connect(gain).connect(this.buses ? this.buses.near : this.master);
    src.start();

    let stopped = false;
    return {
      setVolume: (v) => {
        if (!stopped) gain.gain.value = Math.max(0, v);
      },
      setRate: (r) => {
        if (!stopped) src.playbackRate.value = r;
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { src.stop(); } catch (e) { /* 已停止 */ }
      },
    };
  }

  // ---------------- 合成音源（BGM / 环境音 / 嘶吼 / 音效） ----------------
  /** 可循环褐噪声缓冲（风声 / 爆炸 / 火焰的基底） */
  _noiseBuffer(seconds = 1.2) {
    if (!this.ctx) return null;
    if (this._noise) return this._noise;
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.0;
    }
    this._noise = buf;
    return buf;
  }

  /** 单音扫频：所有合成音效的基础单元 */
  _tone({ type = 'sine', f0 = 200, f1 = null, dur = 0.25, vol = 0.1, delay = 0, bus = 'near' } = {}) {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1 !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + dur * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect((this.buses && this.buses[bus]) || this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** 噪声爆音（爆炸 / 火焰 / 嘶吼的粗糙质感） */
  _noiseHit({ dur = 0.4, vol = 0.15, type = 'lowpass', freq = 600, delay = 0, bus = 'near' } = {}) {
    if (!this.ctx || !this.master) return;
    const buf = this._noiseBuffer();
    if (!buf) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.35), t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect((this.buses && this.buses[bus]) || this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  /** 战斗 BGM：低频持续音 + 张力脉冲（强度随波次提升） */
  startBattleMusic() {
    if (!this.ctx || !this.master) return;
    this.stopMusic();
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.22;
    bus.connect(this.buses ? this.buses.music : this.master);

    const drone = ctx.createOscillator();
    drone.type = 'sawtooth';
    drone.frequency.value = 55;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    lp.Q.value = 2.2;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.08;
    drone.connect(lp).connect(droneGain).connect(bus);
    drone.start();

    const pad = ctx.createOscillator();
    pad.type = 'triangle';
    pad.frequency.value = 110;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    pad.connect(padGain).connect(bus);
    pad.start();

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 27.5;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.03;
    sub.connect(subGain).connect(bus);
    sub.start();

    this.music = { type: 'battle', bus, nodes: [drone, pad, sub], droneGain, padGain, subGain };
    this._pulseTimer = 0.8;
  }

  /** 大厅 BGM：舒缓的双层三角波垫音 */
  startLobbyMusic() {
    if (!this.ctx || !this.master) return;
    this.stopMusic();
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.16;
    bus.connect(this.buses ? this.buses.music : this.master);

    const pad = ctx.createOscillator();
    pad.type = 'triangle';
    pad.frequency.value = 96;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    pad.connect(padGain).connect(bus);
    pad.start();

    const high = ctx.createOscillator();
    high.type = 'triangle';
    high.frequency.value = 144;
    const highGain = ctx.createGain();
    highGain.gain.value = 0.025;
    high.connect(highGain).connect(bus);
    high.start();

    this.music = { type: 'lobby', bus, nodes: [pad, high], padGain, highGain };
  }

  stopMusic() {
    if (!this.music) return;
    for (const n of this.music.nodes) {
      try { n.stop(); } catch (e) { /* 已停止 */ }
    }
    try { this.music.bus.disconnect(); } catch (e) { /* ignore */ }
    this.music = null;
  }

  /** 战斗环境音：持续风声 + 随机远处乌鸦 */
  startAmbience() {
    if (!this.ctx || !this.master || this.ambience) return;
    const buf = this._noiseBuffer();
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    src.connect(lp).connect(gain).connect(this.buses ? this.buses.amb : this.master);
    src.start();
    this.ambience = { src, gain };
    this._crowTimer = 8 + Math.random() * 8;
  }

  stopAmbience() {
    if (!this.ambience) return;
    try { this.ambience.src.stop(); } catch (e) { /* ignore */ }
    this.ambience = null;
  }

  /** BGM 张力（0 = 平静，1 = 最高压） */
  setBattleIntensity(k) {
    this._intensity = Math.max(0, Math.min(1, Number(k) || 0));
  }

  /** 每帧推进合成音源（脉冲 / 风声 / 乌鸦） */
  update(dt) {
    if (!this.ctx) return;
    this._time += dt;

    if (this.music && this.music.type === 'battle') {
      const k = this._intensity;
      if (this.music.droneGain) this.music.droneGain.gain.value = 0.07 + k * 0.08;
      if (this.music.padGain) this.music.padGain.gain.value = 0.04 + k * 0.05;
      if (this.music.bus) this.music.bus.gain.value = 0.2 + k * 0.1;
      this._pulseTimer -= dt;
      if (this._pulseTimer <= 0) {
        this._pulseTimer = 1.6 - k * 0.9;
        this._tone({ type: 'sine', f0: 72, f1: 42, dur: 0.34, vol: 0.04 + k * 0.03, bus: 'music' });
      }
    } else if (this.music && this.music.type === 'lobby' && this.music.padGain) {
      this.music.padGain.gain.value = 0.05 + Math.sin(this._time * 0.5) * 0.015;
    }

    if (this.ambience) {
      this.ambience.gain.gain.value = 0.045 + Math.sin(this._time * 0.7) * 0.018;
      this._crowTimer -= dt;
      if (this._crowTimer <= 0) {
        this._crowTimer = 14 + Math.random() * 16;
        this._tone({ type: 'sawtooth', f0: 520, f1: 300, dur: 0.16, vol: 0.02, bus: 'amb' });
        this._tone({ type: 'sawtooth', f0: 480, f1: 260, dur: 0.18, vol: 0.018, delay: 0.26, bus: 'amb' });
      }
    }
  }

  /** 丧尸嘶吼：不同变体音高不同，按距离衰减；有位置时走空间声 */
  playGrowl(variantId, distance = 10, position = null) {
    if (!this.ctx) return;
    const vol = this.distanceVolume(distance, 34) * 0.9;
    if (vol <= 0.01) return;
    const cfg = {
      walker: [160, 105, 0.6],
      runner: [340, 210, 0.5],
      swift: [300, 190, 0.45],
      fat: [95, 60, 0.95],
      brute: [110, 70, 0.85],
      spitter: [210, 140, 0.6],
      boss: [75, 45, 1.3],
    }[variantId] || [160, 105, 0.6];
    if (position) {
      // 空间声：用合成音色做一次性 buffer 太贵，这里保留音量衰减 + 左右声像
      const panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.rolloffFactor = 0.7;
      panner.maxDistance = 90;
      this._setPannerPos(panner, position);
      panner.connect(this.buses ? this.buses.world : this.master);
      this._growlTo(panner, cfg, vol);
      return;
    }
    this._growlTo(null, cfg, vol);
  }

  /** 嘶吼合成：锯齿波 + 带通噪声，可选挂到某个输出节点 */
  _growlTo(dest, cfg, vol) {
    const ctx = this.ctx;
    const out = dest || (this.buses ? this.buses.near : this.master);
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(Math.max(20, cfg[0]), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, cfg[1]), t0 + cfg[2]);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + cfg[2] * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + cfg[2]);
    osc.connect(gain).connect(out);
    osc.start(t0);
    osc.stop(t0 + cfg[2] + 0.03);

    const buf = this._noiseBuffer();
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(cfg[0] * 2.2, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, cfg[0] * 0.8), t0 + cfg[2] * 0.6);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * 0.5), t0 + 0.03);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + cfg[2] * 0.6);
      src.connect(filter).connect(ng).connect(out);
      src.start(t0);
      // 噪声尾巴最长：以它的结束时间统一清理这次嘶吼的所有临时节点
      src.stop(t0 + cfg[2] * 0.6 + 0.03);
      if (dest) {
        src.onended = () => {
          try {
            src.disconnect(); filter.disconnect(); ng.disconnect();
            osc.disconnect(); gain.disconnect(); dest.disconnect();
          } catch (e) { /* ignore */ }
        };
      }
    }
  }

  /** 合成音效：boom 爆炸 / fire 燃烧 / alarm 警报 / pickup 拾取 / chime 强化 */
  playSfx(name) {
    if (!this.ctx || !this.master) return;
    if (name === 'boom') {
      this._noiseHit({ dur: 0.55, vol: 0.28, type: 'lowpass', freq: 900, bus: 'near' });
      this._tone({ type: 'sine', f0: 120, f1: 40, dur: 0.5, vol: 0.16, bus: 'near' });
    } else if (name === 'fire') {
      this._noiseHit({ dur: 0.7, vol: 0.09, type: 'bandpass', freq: 900, bus: 'near' });
    } else if (name === 'alarm') {
      for (let i = 0; i < 3; i++) {
        this._tone({ type: 'square', f0: 660, f1: 1080, dur: 0.35, vol: 0.05, delay: i * 0.5, bus: 'dry' });
        this._tone({ type: 'square', f0: 1080, f1: 660, dur: 0.35, vol: 0.05, delay: i * 0.5 + 0.18, bus: 'dry' });
      }
    } else if (name === 'pickup') {
      this._tone({ type: 'sine', f0: 880, dur: 0.12, vol: 0.06, bus: 'dry' });
      this._tone({ type: 'sine', f0: 1320, dur: 0.16, vol: 0.05, delay: 0.1, bus: 'dry' });
    } else if (name === 'chime') {
      this._tone({ type: 'triangle', f0: 523, dur: 0.5, vol: 0.06, bus: 'music' });
      this._tone({ type: 'triangle', f0: 659, dur: 0.5, vol: 0.05, delay: 0.08, bus: 'music' });
      this._tone({ type: 'triangle', f0: 784, dur: 0.6, vol: 0.04, delay: 0.16, bus: 'music' });
    }
  }

  /** 按距离衰减的音量（敌人枪声用） */
  distanceVolume(distance, maxDistance = 46) {
    return Math.max(0, 1 - distance / maxDistance) * 0.55;
  }
}
