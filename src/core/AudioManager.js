/**
 * 音频管理器（WebAudio）
 * 使用仓库原有 WAV 音效：开火、空仓、换弹、抛壳、脚步循环。
 * 通过 AudioBuffer 缓存实现低延迟、可叠加播放。
 */
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

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.enabled = true;
    this.volume = 1.0;       // 主音量（设置界面可调）
    this.master = null;      // 总音量节点
    this._lastPlay = {};     // 同名音效上次播放时间，防叠加爆音

    // 合成音源（BGM / 环境音 / 嘶吼），不依赖任何外部素材
    this.music = null;
    this.ambience = null;
    this._intensity = 0;
    this._pulseTimer = 0;
    this._crowTimer = 0;
    this._time = 0;
    this._noise = null;
  }

  /** 初始化音频上下文并解码全部音效 */
  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[Audio] 当前浏览器不支持 WebAudio');
      return;
    }
    this.ctx = new Ctx();
    // 总音量节点：所有音效先汇入 master 再进扬声器
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
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

  /** 用户手势后恢复音频上下文 */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * 播放一次性音效
   * @param {string} name 音效名
   * @param {{volume?:number, rate?:number}} opts
   */
  play(name, opts = {}) {
    if (!this.ctx || !this.buffers[name] || !this.enabled) return;
    // 同名音效限流，避免高速连续射击/连续受击时叠爆
    const now = this.ctx.currentTime;
    const gap = MIN_INTERVAL[name] || 0;
    if (gap && this._lastPlay[name] !== undefined && now - this._lastPlay[name] < gap) return;
    this._lastPlay[name] = now;

    const { volume = 1, rate = 1 } = opts;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;
    gain.gain.value = volume;
    src.connect(gain).connect(this.master);
    src.start();
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
    src.connect(gain).connect(this.master);
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
  _tone({ type = 'sine', f0 = 200, f1 = null, dur = 0.25, vol = 0.1, delay = 0 } = {}) {
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
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** 噪声爆音（爆炸 / 火焰 / 嘶吼的粗糙质感） */
  _noiseHit({ dur = 0.4, vol = 0.15, type = 'lowpass', freq = 600, delay = 0 } = {}) {
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
    src.connect(filter).connect(gain).connect(this.master);
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
    bus.connect(this.master);

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
    bus.connect(this.master);

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
    src.connect(lp).connect(gain).connect(this.master);
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
        this._tone({ type: 'sine', f0: 72, f1: 42, dur: 0.34, vol: 0.04 + k * 0.03 });
      }
    } else if (this.music && this.music.type === 'lobby' && this.music.padGain) {
      this.music.padGain.gain.value = 0.05 + Math.sin(this._time * 0.5) * 0.015;
    }

    if (this.ambience) {
      this.ambience.gain.gain.value = 0.045 + Math.sin(this._time * 0.7) * 0.018;
      this._crowTimer -= dt;
      if (this._crowTimer <= 0) {
        this._crowTimer = 14 + Math.random() * 16;
        this._tone({ type: 'sawtooth', f0: 520, f1: 300, dur: 0.16, vol: 0.02 });
        this._tone({ type: 'sawtooth', f0: 480, f1: 260, dur: 0.18, vol: 0.018, delay: 0.26 });
      }
    }
  }

  /** 丧尸嘶吼：不同变体音高不同，按距离衰减 */
  playGrowl(variantId, distance = 10) {
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
    this._tone({ type: 'sawtooth', f0: cfg[0], f1: cfg[1], dur: cfg[2], vol });
    this._noiseHit({ dur: cfg[2] * 0.6, vol: vol * 0.5, type: 'bandpass', freq: cfg[0] * 2.2 });
  }

  /** 合成音效：boom 爆炸 / fire 燃烧 / alarm 警报 / pickup 拾取 / chime 强化 */
  playSfx(name) {
    if (!this.ctx || !this.master) return;
    if (name === 'boom') {
      this._noiseHit({ dur: 0.55, vol: 0.28, type: 'lowpass', freq: 900 });
      this._tone({ type: 'sine', f0: 120, f1: 40, dur: 0.5, vol: 0.16 });
    } else if (name === 'fire') {
      this._noiseHit({ dur: 0.7, vol: 0.09, type: 'bandpass', freq: 900 });
    } else if (name === 'alarm') {
      for (let i = 0; i < 3; i++) {
        this._tone({ type: 'square', f0: 660, f1: 1080, dur: 0.35, vol: 0.05, delay: i * 0.5 });
        this._tone({ type: 'square', f0: 1080, f1: 660, dur: 0.35, vol: 0.05, delay: i * 0.5 + 0.18 });
      }
    } else if (name === 'pickup') {
      this._tone({ type: 'sine', f0: 880, dur: 0.12, vol: 0.06 });
      this._tone({ type: 'sine', f0: 1320, dur: 0.16, vol: 0.05, delay: 0.1 });
    } else if (name === 'chime') {
      this._tone({ type: 'triangle', f0: 523, dur: 0.5, vol: 0.06 });
      this._tone({ type: 'triangle', f0: 659, dur: 0.5, vol: 0.05, delay: 0.08 });
      this._tone({ type: 'triangle', f0: 784, dur: 0.6, vol: 0.04, delay: 0.16 });
    }
  }

  /** 按距离衰减的音量（敌人枪声用） */
  distanceVolume(distance, maxDistance = 46) {
    return Math.max(0, 1 - distance / maxDistance) * 0.55;
  }
}
