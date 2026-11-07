/**
 * 局外成长配置（v0.5）
 *
 * - 等级 / 经验：击杀与清波给经验，升级获得属性点；
 * - 属性（`permanent`）：生命 / 护甲 / 伤害 / 移速，属性点自由分配；
 * - 天赋（`talents`）：攻击 / 防御 / 机动三条分支，各 5 级，消耗金币 + 觉醒材料；
 * - 机甲（`unlocks.mechs`）：装甲形态 / 重装兵装 / 哨戒炮塔，消耗金币 + 机甲材料解锁。
 *
 * 这里只放纯数据与纯函数，不碰存档与场景，方便单测。
 */

/** 等级与经验（无等级上限，经验可无限累计升级） */
export const LEVEL = {
  max: Infinity,
  xpPerKill: 10,
  xpPerWave: 40,
  xpWin: 200,
  xpLose: 0,
  pointsPerLevel: 1,
};

/** 升到下一级所需经验（当前等级 → 下一级） */
export function xpToNext(level) {
  // 每级递增 80：Lv5 约 1 局、Lv10 约 3.5 局、Lv20 约 12 局，成长按局数铺开
  return 200 + (Math.max(1, level) - 1) * 80;
}

/** 属性点：每点加成与上限（无上限，成本持续递增由 SaveManager 控制） */
export const ATTRIBUTES = {
  hp: { id: 'hp', name: '体能', desc: '最大生命 +8', perPoint: 8, max: Infinity },
  armor: { id: 'armor', name: '护甲', desc: '最大护甲 +5', perPoint: 5, max: Infinity },
  dmg: { id: 'dmg', name: '火力', desc: '武器伤害 +2%', perPoint: 0.02, max: Infinity },
  speed: { id: 'speed', name: '机动', desc: '移动速度 +1.5%', perPoint: 0.015, max: Infinity },
};

/** 天赋：三条分支，前 5 级按 costs 配置，超出后成本持续递增（无上限） */
export const TALENTS = {
  atk: {
    id: 'atk',
    name: '攻击',
    desc: '每级：伤害 +3% · 射速 +2%',
    dmgPerLevel: 0.03,
    fireRatePerLevel: 0.02,
    costs: [
      { coins: 150, awaken: 1 },
      { coins: 250, awaken: 2 },
      { coins: 400, awaken: 3 },
      { coins: 600, awaken: 5 },
      { coins: 900, awaken: 8 },
    ],
    step: { coins: 300, awaken: 2 },
  },
  def: {
    id: 'def',
    name: '防御',
    desc: '每级：最大生命 +10 · 最大护甲 +5',
    hpPerLevel: 10,
    armorPerLevel: 5,
    costs: [
      { coins: 150, awaken: 1 },
      { coins: 250, awaken: 2 },
      { coins: 400, awaken: 3 },
      { coins: 600, awaken: 5 },
      { coins: 900, awaken: 8 },
    ],
    step: { coins: 300, awaken: 2 },
  },
  mob: {
    id: 'mob',
    name: '机动',
    desc: '每级：移速 +3% · 换弹速度 +4%',
    speedPerLevel: 0.03,
    reloadPerLevel: 0.04,
    costs: [
      { coins: 150, awaken: 1 },
      { coins: 250, awaken: 2 },
      { coins: 400, awaken: 3 },
      { coins: 600, awaken: 5 },
      { coins: 900, awaken: 8 },
    ],
    step: { coins: 300, awaken: 2 },
  },
};

/** 天赋升级花费；已满 5 级后成本持续递增，永不返回 null（无上限） */
export function talentCost(branch, currentLevel) {
  const def = TALENTS[branch];
  if (!def) return null;
  const idx = currentLevel; // 升到 currentLevel+1 级的花费，下标从 0 开始
  if (idx < def.costs.length) return def.costs[idx];
  // 超过配置的 5 级：按第 5 级成本递推，每级额外 +step
  const last = def.costs[def.costs.length - 1];
  const over = idx - def.costs.length + 1;
  return {
    coins: last.coins + def.step.coins * over,
    awaken: last.awaken + def.step.awaken * over,
  };
}

/**
 * 机甲：`type = buff` 为个人增益形态，`deploy` 为部署物。
 * duration 单位为秒；cost 为金币 + 机甲材料。
 */
export const MECHS = {
  armor: {
    id: 'armor',
    name: '装甲形态',
    desc: '独立 250 护盾 · 伤害 ×1.8 · 移速 ×0.55 · 燃料 90 秒',
    type: 'buff',
    duration: 90,
    shield: 250,
    dmgMul: 1.8,
    speedMul: 0.55,
    fireRateMul: 1,
    cost: { coins: 1200, mecha: 3 },
  },
  heavy: {
    id: 'heavy',
    name: '重装兵装',
    desc: '独立 120 护盾 · 伤害 ×1.6 · 射速 ×1.5 · 移速 ×0.8 · 燃料 60 秒',
    type: 'buff',
    duration: 60,
    shield: 120,
    dmgMul: 1.6,
    speedMul: 0.8,
    fireRateMul: 1.5,
    cost: { coins: 1500, mecha: 4 },
  },
  turret: {
    id: 'turret',
    name: '哨戒炮塔',
    desc: '部署一台自动炮塔，自动索敌 · 持续 20 秒',
    type: 'deploy',
    duration: 20,
    damage: 22,
    range: 22,
    cooldown: 0.55,
    cost: { coins: 900, mecha: 2 },
  },
};

/** 机甲列表（固定顺序，供 UI 渲染） */
export const MECH_ORDER = ['armor', 'heavy', 'turret'];

/**
 * 汇总所有局外加成，供运行时一次性应用。
 * @param {object} data SaveManager.data
 * @returns {{maxHpBonus:number, maxArmorBonus:number, dmgMul:number, speedMul:number, fireRateMul:number, reloadMul:number}}
 */
export function growthTotals(data = {}) {
  const perm = data.permanent || {};
  const tal = data.talents || {};
  const maxHpBonus = (perm.hp || 0) * ATTRIBUTES.hp.perPoint + (tal.def || 0) * TALENTS.def.hpPerLevel;
  const maxArmorBonus = (perm.armor || 0) * ATTRIBUTES.armor.perPoint + (tal.def || 0) * TALENTS.def.armorPerLevel;
  const dmgMul = 1 + (perm.dmg || 0) * ATTRIBUTES.dmg.perPoint + (tal.atk || 0) * TALENTS.atk.dmgPerLevel;
  const fireRateMul = 1 + (tal.atk || 0) * TALENTS.atk.fireRatePerLevel;
  const speedMul = 1 + (perm.speed || 0) * ATTRIBUTES.speed.perPoint + (tal.mob || 0) * TALENTS.mob.speedPerLevel;
  // 换弹：等级越高耗时越短，无下限（可无限加快）
  const reloadMul = 1 - (tal.mob || 0) * TALENTS.mob.reloadPerLevel;
  return { maxHpBonus, maxArmorBonus, dmgMul, speedMul, fireRateMul, reloadMul };
}

/** 本局应得经验（与结算奖励一起发） */
export function runXp({ kills = 0, waves = 0, win = false } = {}) {
  return kills * LEVEL.xpPerKill
    + waves * LEVEL.xpPerWave
    + (win ? LEVEL.xpWin : LEVEL.xpLose);
}
