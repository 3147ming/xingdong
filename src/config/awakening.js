/**
 * 觉醒模式（Awakening Mode）配置
 *
 * 和 endless 的区别：
 *   每 3 波弹出觉醒选项（比 perk 强力得多），并随觉醒路线累积触发"形态变化"。
 *   波次曲线更激进：血量 / 伤害 / 速度增长更快，首领波次提前。
 *
 * 觉醒路线（route）：玩家累积某路线觉醒次数触发形态解锁。
 *   fury   — 狂暴之路 ：攻击极致（伤害 / 射速 / 穿透 / 爆裂 / 暴击）
 *   warden — 守护之路 ：生存极致（生命 / 护甲 / 回血 / 移速 / 僵直抗性）
 *   arcane — 异能之路 ：特殊效果（时间减缓 / 双重射击 / 弹射 / 全局减速 / 伤害光环）
 *
 * 每条路线 3 级形态（form）：2/4/6 次觉醒触发，附带视觉变化 + 额外属性。
 */

export const AWAKEN_ROUTES = {
  fury: { id: 'fury',   name: '狂暴之路', color: '#ff4a2a', glow: 0xff4a2a },
  warden: { id: 'warden', name: '守护之路', color: '#4aff6a', glow: 0x4aff6a },
  arcane: { id: 'arcane', name: '异能之路', color: '#aa6aff', glow: 0xaa6aff },
};

/** 觉醒触发间隔（每 N 波触发一次） */
export const AWAKEN_EVERY = 3;

/** 每路线的形态解锁阈值（觉醒次数） */
export const FORM_THRESHOLDS = [2, 4, 6];

/**
 * 形态解锁后给予的额外永久增益（叠加到 perk 上）。
 * formBonus(route, level) → mod 对象（和 emptyPerkMods 字段一致）。
 */
export function formBonus(route, level) {
  const out = {};
  if (route === 'fury') {
    if (level >= 1) { out.dmgAdd = (out.dmgAdd || 0) + 0.15; out.critAdd = (out.critAdd || 0) + 0.05; }
    if (level >= 2) { out.fireRateAdd = (out.fireRateAdd || 0) + 0.10; out.explodeRadius = (out.explodeRadius || 0) + 0.6; out.explodeDamage = (out.explodeDamage || 0) + 15; }
    if (level >= 3) { out.dmgAdd = (out.dmgAdd || 0) + 0.25; out.critMul = 3.5; out.critAdd = (out.critAdd || 0) + 0.10; }
  } else if (route === 'warden') {
    if (level >= 1) { out.hpAdd = (out.hpAdd || 0) + 40; out.armorAdd = (out.armorAdd || 0) + 20; }
    if (level >= 2) { out.hpAdd = (out.hpAdd || 0) + 50; out.killHeal = (out.killHeal || 0) + 2; out.slowResist = (out.slowResist || 0) + 0.3; }
    if (level >= 3) { out.armorAdd = (out.armorAdd || 0) + 40; out.speedAdd = (out.speedAdd || 0) + 0.15; out.killHeal = (out.killHeal || 0) + 3; }
  } else if (route === 'arcane') {
    if (level >= 1) { out.slowMoAdd = (out.slowMoAdd || 0) + 0.10; }
    if (level >= 2) { out.slowMoAdd = (out.slowMoAdd || 0) + 0.15; out.extraPellets = (out.extraPellets || 0) + 1; }
    if (level >= 3) { out.bounceAdd = (out.bounceAdd || 0) + 2; out.slowMoAdd = (out.slowMoAdd || 0) + 0.15; }
  }
  return out;
}

/**
 * 觉醒 perk 定义。
 * 和 PERK_DEFS 类似，但效果更强，且按 route 分组。
 * apply(m)：m 为当前增益累积对象（会叠加）。
 */
export const AWAKEN_DEFS = [
  // ---- fury ----
  {
    id: 'fury_frenzy', route: 'fury', name: '狂暴狂热',
    desc: '所有武器伤害 +60%',
    apply: (m) => { m.dmgAdd = (m.dmgAdd || 0) + 0.60; },
  },
  {
    id: 'fury_blitz', route: 'fury', name: '疾风连射',
    desc: '射速 +50%，换弹速度 +30%',
    apply: (m) => { m.fireRateAdd = (m.fireRateAdd || 0) + 0.50; m.reloadCut = (m.reloadCut || 0) + 0.30; },
  },
  {
    id: 'fury_piercer', route: 'fury', name: '贯穿裂隙',
    desc: '穿透 +5，爆裂弹头 +0.5 半径 / +30 伤害',
    apply: (m) => { m.pierceAdd = (m.pierceAdd || 0) + 5; m.explodeRadius = (m.explodeRadius || 0) + 0.5; m.explodeDamage = (m.explodeDamage || 0) + 30; },
  },
  {
    id: 'fury_vengeance', route: 'fury', name: '复仇时刻',
    desc: '暴击率 +35%，暴击伤害 ×4',
    apply: (m) => { m.critAdd = (m.critAdd || 0) + 0.35; m.critMul = 4; },
  },

  // ---- warden ----
  {
    id: 'warden_vitality', route: 'warden', name: '不灭体魄',
    desc: '最大生命 +120，最大护甲 +60，立即补满',
    apply: (m) => { m.hpAdd = (m.hpAdd || 0) + 120; m.armorAdd = (m.armorAdd || 0) + 60; },
  },
  {
    id: 'warden_regen', route: 'warden', name: '战场再生',
    desc: '每次击杀回 6 点生命；护甲每 4 秒自动回 1 点',
    apply: (m) => { m.killHeal = (m.killHeal || 0) + 6; m.armorRegen = (m.armorRegen || 0) + 0.25; },
  },
  {
    id: 'warden_momentum', route: 'warden', name: '钢铁意志',
    desc: '受击僵直免疫，移速 +30%',
    apply: (m) => { m.slowResist = (m.slowResist || 0) + 1.0; m.speedAdd = (m.speedAdd || 0) + 0.30; },
  },
  {
    id: 'warden_bulwark', route: 'warden', name: '壁垒姿态',
    desc: '护甲受到伤害减少 40%，生命受到伤害减少 15%',
    apply: (m) => { m.armorDmgCut = (m.armorDmgCut || 0) + 0.40; m.hpDmgCut = (m.hpDmgCut || 0) + 0.15; },
  },

  // ---- arcane ----
  {
    id: 'arcane_timeslip', route: 'arcane', name: '时术裂缝',
    desc: '子弹时间效果 +30%（开枪后周围敌人大幅减速）',
    apply: (m) => { m.slowMoAdd = (m.slowMoAdd || 0) + 0.30; },
  },
  {
    id: 'arcane_echo', route: 'arcane', name: '回声共鸣',
    desc: '每次开火额外射出 3 颗追踪弹丸（60% 伤害）',
    apply: (m) => { m.extraPellets = (m.extraPellets || 0) + 3; m.pelletDamage = (m.pelletDamage || 1) * 0.6; },
  },
  {
    id: 'arcane_chain', route: 'arcane', name: '连锁闪电',
    desc: '子弹额外弹射 4 次（80% 伤害）',
    apply: (m) => { m.bounceAdd = (m.bounceAdd || 0) + 4; m.bounceDamageMul = (m.bounceDamageMul || 1) * 0.8; },
  },
  {
    id: 'arcane_aura', route: 'arcane', name: '残响领域',
    desc: '身边 12 米内所有敌人持续受 15 dps 伤害（觉醒光环）',
    apply: (m) => { m.auraDps = (m.auraDps || 0) + 15; m.auraRadius = (m.auraRadius || 0) + 12; },
  },
];

/** 觉醒模式波次曲线参数（比 endless 更激进） */
export const AWAKEN_CURVE = {
  baseTotal: 8,
  totalStep: 3,           // 每波 +3（endless 是 +2）
  maxTotal: 36,
  baseAlive: 5,
  maxAlive: 14,
  healthStep: 1.13,       // 每波血量 ×1.13（endless 是 ×1.10）
  healthCap: 5.5,         // 血量上限更高
  bossEvery: 6,           // 每 6 波首领（endless 是 8）
};

/** 生成觉醒模式第 n 波配置（n 从 1 开始） */
export function awakenWave(n) {
  const wave = Math.max(1, Math.floor(n));
  const total = AWAKEN_CURVE.baseTotal + AWAKEN_CURVE.totalStep * (wave - 1);
  const alive = AWAKEN_CURVE.baseAlive + Math.floor((wave - 1) / 2);
  const healthMul = Math.min(AWAKEN_CURVE.healthCap, Math.pow(AWAKEN_CURVE.healthStep, wave - 1));

  const pool = [];
  pool.push('swift');
  if (wave >= 2) pool.push('spitter');
  if (wave >= 3) pool.push('runner');
  if (wave >= 3) pool.push('bomber');
  if (wave >= 4) pool.push('howler');
  if (wave >= 5) pool.push('brute');
  if (wave >= 5) pool.push('fat');
  if (wave >= 7) pool.push('boss');

  const extras = Math.min(total - 1, Math.floor(total * 0.65));
  const mix = { walker: total - extras };
  for (let i = 0; i < extras; i++) {
    const v = pool[i % pool.length];
    mix[v] = (mix[v] || 0) + 1;
  }
  if (wave % AWAKEN_CURVE.bossEvery === 0) mix.boss = (mix.boss || 0) + 1;

  return {
    total,
    alive,
    mix,
    healthMul,
    damageMul: 1 + 0.06 * (wave - 1),
    accuracyMul: 1 + 0.025 * (wave - 1),
    speedMul: 1 + 0.015 * (wave - 1),
  };
}
