/**
 * 模式 / 关卡 / 平衡配置
 *
 * P0：把原本硬编码在 MATCH.waves 里的波次搬到这里，行为完全不变；
 * 后续 P1/P2 会在这里补上 5 关配置与无尽模式生成规则。
 *
 * 本文件只放纯数据与纯函数，不 import 任何运行时模块，避免循环依赖。
 */

/** 闯关模式第 1 关（沿用现有三波配置，P1 起会拆成 5 关） */
export const CAMPAIGN_WAVES = [
  // total：本波总数；alive：同时存活上限；mix：变体配额
  {
    total: 28, alive: 12, mix: { walker: 18, swift: 6, spitter: 4 },
    healthMul: 1.00, damageMul: 1.00, accuracyMul: 0.85, speedMul: 1.00,
  },
  {
    total: 36, alive: 16, mix: { walker: 18, spitter: 6, swift: 6, bomber: 2, brute: 4 },
    healthMul: 1.10, damageMul: 1.05, accuracyMul: 1.00, speedMul: 1.05,
  },
  {
    total: 48, alive: 20, mix: { walker: 20, spitter: 6, brute: 6, swift: 8, bomber: 4, howler: 4, runner: 4 },
    healthMul: 1.22, damageMul: 1.15, accuracyMul: 1.10, speedMul: 1.08,
  },
];

/** 各模式的元信息（大厅卡片、存档键都要用） */
export const MODES = {
  campaign: {
    id: 'campaign',
    name: '闯关行动',
    description: '5 个区域逐关推进，最终在决斗场遭遇首领。',
    waves: CAMPAIGN_WAVES,
    infinite: false,
  },
  endless: {
    id: 'endless',
    name: '无尽生存',
    description: '波次无限循环，难度持续攀升，每 10 波出现首领。',
    waves: null,          // 由 endlessWave() 动态生成
    infinite: true,
  },
  defense: {
    id: 'defense',
    name: '领地守城',
    description: '驻守领地核心，撑过 10 波丧尸大军。',
    waves: null,          // DEFENSE_WAVES
    infinite: false,
  },
  defense_endless: {
    id: 'defense_endless',
    name: '无尽守城',
    description: '丧尸大军无穷无尽，守住核心争取更高波数。',
    waves: null,
    infinite: true,
  },
  awakening: {
    id: 'awakening',
    name: '觉醒模式',
    description: '每 3 波觉醒一次，累积路线强化触发形态解锁。波次曲线更激进。',
    waves: null,
    infinite: true,
    awakening: true,
  },
};

/** 默认模式（探针与 ?mode 缺省都走闯关，保证旧行为不变） */
export const DEFAULT_MODE = 'campaign';

/** 从 URL 查询串解析模式；非法值回落到默认模式 */
export function parseMode(raw) {
  return raw && MODES[raw] ? raw : DEFAULT_MODE;
}

/** 无尽模式曲线参数（平衡上限集中在这里，便于调参） */
export const ENDLESS = {
  baseTotal: 6,           // 第 1 波总数
  totalStep: 2,           // 每波新增数量
  maxTotal: 24,           // 单波数量上限
  baseAlive: 4,           // 第 1 波同屏上限
  maxAlive: 8,            // 同屏上限
  healthStep: 1.10,       // 每波血量复利（放缓前期，拉长成长线）
  healthCap: 3.6,         // 血量倍率上限（约第 14 波触顶）
  bossEvery: 8,           // 每 N 波首领（提高首领核心产出）
};

/**
 * 闯关每关的难度微调。
 * 关卡越高，丧尸血量 / 伤害 / 速度略增；玩家靠局外成长去对冲。
 */
export function campaignWaves(levelIndex = 0) {
  const k = Math.max(0, Math.floor(levelIndex));
  const hp = 1 + 0.10 * k;
  const dmg = 1 + 0.06 * k;
  const spd = 1 + 0.02 * k;
  const acc = 1 + 0.02 * k;
  return CAMPAIGN_WAVES.map((w) => ({
    ...w,
    healthMul: w.healthMul * hp,
    damageMul: w.damageMul * dmg,
    speedMul: w.speedMul * spd,
    accuracyMul: w.accuracyMul * acc,
  }));
}

/** 守城模式参数 */
export const DEFENSE = {
  waves: 10,              // 十轮守城的总波数
  breakSec: 35,           // 波间商店休整时长（打开商店时暂停计时）
  spawnGap: 0.95,         // 守城刷怪间隔（比闯关更密集）
  baseTotal: 9,
  totalStep: 3,
  maxTotal: 30,
  baseAlive: 5,
  maxAlive: 12,
  healthStep: 1.10,
  healthCap: 2.8,
  bossEvery: 5,           // 每 5 波一头首领
  goldPerKill: 6,         // 局内金币：击杀掉落
  goldPerWave: 40,        // 每波肃清奖励
  coreHealth: 1000,       // 领地核心生命
  coreDamageDps: 11,      // 每只贴近核心的丧尸每秒造成的伤害
  coreRadius: 3.6,        // 丧尸攻击核心的判定半径
  turretDamage: 16,
  turretRange: 20,
  turretCooldown: 0.38,
  botDamage: 18,
  botRange: 24,
  botCooldown: 0.85,
  maxBots: 3,
  shop: {                 // 波间商店价格（局内金币）
    turret: 120,
    barricade: 80,
    repair: 60,
    resupply: 60,
    refill: 40,
  },
};

/** 是否属于守城模式 */
export function isDefenseMode(mode) {
  return mode === 'defense' || mode === 'defense_endless';
}

/** 守城第 n 波配置（n 从 1 开始，难度持续攀升，无波次上限） */
export function defenseWave(n) {
  const wave = Math.max(1, Math.floor(n));
  const total = DEFENSE.baseTotal + DEFENSE.totalStep * (wave - 1);
  const alive = DEFENSE.baseAlive + Math.floor((wave - 1) / 2);
  const healthMul = Math.pow(DEFENSE.healthStep, wave - 1);

  const pool = ['swift'];
  if (wave >= 2) pool.push('spitter');
  if (wave >= 3) pool.push('runner');
  if (wave >= 3) pool.push('bomber');
  if (wave >= 4) pool.push('howler');
  if (wave >= 5) pool.push('brute');
  if (wave >= 5) pool.push('fat');

  const extras = Math.min(total - 1, Math.floor(total * 0.6));
  const mix = { walker: total - extras };
  for (let i = 0; i < extras; i++) {
    const v = pool[i % pool.length];
    mix[v] = (mix[v] || 0) + 1;
  }
  if (wave % DEFENSE.bossEvery === 0) mix.boss = (mix.boss || 0) + 1;

  return {
    total,
    alive,
    mix,
    healthMul,
    damageMul: 1 + 0.06 * (wave - 1),
    accuracyMul: 1 + 0.025 * (wave - 1),
    speedMul: 1 + 0.012 * (wave - 1),
  };
}

/** 十轮守城的固定波次表 */
export const DEFENSE_WAVES = Array.from({ length: DEFENSE.waves }, (_, i) => defenseWave(i + 1));

/** 整局通用的平衡上限（全部无上限，成本持续递增，不再卡死成长） */
export const BALANCE = {
  maxDamageBonus: Infinity,     // 觉醒伤害加成：无上限
  maxSpeedBonus: Infinity,      // 移速加成：无上限
  maxHealthBonus: Infinity,     // 额外生命：无上限
  maxArmorBonus: Infinity,      // 额外护甲：无上限
};

/**
 * 生成无尽模式第 n 波配置（n 从 1 开始）
 * 纯函数：同样的 n 永远得到同样的结果，方便单测与回放。
 */
export function endlessWave(n) {
  const wave = Math.max(1, Math.floor(n));
  const total = ENDLESS.baseTotal + ENDLESS.totalStep * (wave - 1);
  const alive = ENDLESS.baseAlive + Math.floor((wave - 1) / 2);
  const healthMul = Math.pow(ENDLESS.healthStep, wave - 1);

  // 变体池按波次逐步解锁
  const pool = [];
  pool.push('swift');            // 第 1 波起
  if (wave >= 2) pool.push('spitter');
  if (wave >= 3) pool.push('runner');
  if (wave >= 3) pool.push('bomber');
  if (wave >= 4) pool.push('howler');
  if (wave >= 5) pool.push('brute');
  if (wave >= 5) pool.push('fat');

  // 最多 55% 的名额分给特殊变体，剩下的都是普通丧尸
  const extras = Math.min(total - 1, Math.floor(total * 0.55));
  const mix = { walker: total - extras };
  for (let i = 0; i < extras; i++) {
    const v = pool[i % pool.length];
    mix[v] = (mix[v] || 0) + 1;
  }

  // 首领波：额外追加一头首领，不计入 total
  const boss = wave % ENDLESS.bossEvery === 0;
  if (boss) mix.boss = (mix.boss || 0) + 1;

  return {
    total,
    alive,
    mix,
    healthMul,
    damageMul: 1 + 0.05 * (wave - 1),
    accuracyMul: 1 + 0.02 * (wave - 1),
    speedMul: 1 + 0.01 * (wave - 1),
  };
}


