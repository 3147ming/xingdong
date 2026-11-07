/**
 * 经济 / 材料 / 解锁 / 科研配置（v0.6）
 *
 * 这里只放纯数据与纯函数：
 *  - 材料注册表与地图专属材料映射
 *  - 备弹商店（按武器口径计价）
 *  - 材料采购（价格随购买次数递增，不限购）
 *  - 货币兑换（双向差价）
 *  - 科研所 6 条研究线
 *  - 枪械改装解锁（槽位金币、配件制造、元素配件声望）
 *
 * 所有数值为初版，平衡阶段统一调整。
 */

/** 材料注册表：id / 名称 / 用途 / 稀有度 */
export const MATERIALS = {
  awaken: { id: 'awaken', name: '觉醒材料', desc: '身体觉醒升级消耗', tier: 1 },
  mecha: { id: 'mecha', name: '机甲材料', desc: '机甲解锁消耗', tier: 2 },
  researchAmmo: { id: 'researchAmmo', name: '弹道研究数据', desc: '科研·弹道 / 收益', tier: 1 },
  researchCombat: { id: 'researchCombat', name: '战斗研究数据', desc: '科研·火力 / 弱点', tier: 1 },
  researchLogistics: { id: 'researchLogistics', name: '后勤研究数据', desc: '科研·生存 / 后勤', tier: 1 },
  bossCore: { id: 'bossCore', name: '首领核心', desc: '首领专属 · 顶级解锁', tier: 4 },
  mapYard: { id: 'mapYard', name: '货场废料', desc: '露天货场产出', tier: 3 },
  mapDock: { id: 'mapDock', name: '码头合金', desc: '集装箱码头产出', tier: 3 },
  mapGarage: { id: 'mapGarage', name: '车库零件', desc: '地下停车场产出', tier: 3 },
  mapLogistics: { id: 'mapLogistics', name: '园区芯片', desc: '物流园区产出', tier: 3 },
  mapArena: { id: 'mapArena', name: '决斗场徽记', desc: '决斗场产出', tier: 3 },
  mapDefense: { id: 'mapDefense', name: '防线凭证', desc: '领地防线产出', tier: 3 },
};

/** 地图 id → 地图专属材料 */
export const MAP_MATERIAL = {
  yard: 'mapYard',
  dock: 'mapDock',
  garage: 'mapGarage',
  logistics: 'mapLogistics',
  arena: 'mapArena',
  defense: 'mapDefense',
};

/** 备弹商店：按武器口径分别计价 */
export const AMMO_SHOP = {
  rifle: { weapon: 'rifle', name: '步枪弹', rounds: 30, price: 20, cap: 360 },
  pistol: { weapon: 'pistol', name: '手枪弹', rounds: 30, price: 10, cap: 240 },
  shotgun: { weapon: 'shotgun', name: '霰弹', rounds: 18, price: 35, cap: 144 },
  sniper: { weapon: 'sniper', name: '狙击弹', rounds: 10, price: 55, cap: 80 },
};

/** 材料采购：价格 = basePrice + priceStep × 已购次数（不限购） */
export const MATERIAL_SHOP = {
  awaken: {
    material: 'awaken',
    name: '觉醒材料',
    basePrice: 600,
    priceStep: 300,
    unlock: { reputation: 20, level: 3 },
  },
  mecha: {
    name: '机甲材料',
    basePrice: 900,
    priceStep: 500,
    unlock: { reputation: 60, level: 8 },
  },
  researchAmmo: {
    name: '弹道研究数据',
    basePrice: 500,
    priceStep: 250,
    unlock: { reputation: 60, level: 10 },
  },
  researchCombat: {
    name: '战斗研究数据',
    basePrice: 500,
    priceStep: 250,
    unlock: { reputation: 60, level: 10 },
  },
  researchLogistics: {
    name: '后勤研究数据',
    basePrice: 500,
    priceStep: 250,
    unlock: { reputation: 60, level: 10 },
  },
  bossCore: {
    name: '首领核心',
    basePrice: 3000,
    priceStep: 1500,
    unlock: { reputation: 200, level: 20 },
  },
};

/** 材料当前价格 */
export function materialPrice(def, bought = 0) {
  return def.basePrice + def.priceStep * Math.max(0, bought);
}

/** 货币兑换：双向差价（from → to） */
export const EXCHANGE_OPS = [
  { id: 'sellCoreRep', label: '1 核心 → 100 声望', from: 'cores', fromAmount: 1, to: 'reputation', toAmount: 100 },
  { id: 'sellCoreCoins', label: '1 核心 → 10000 金币', from: 'cores', fromAmount: 1, to: 'coins', toAmount: 10000 },
  { id: 'sellRepCoins', label: '1 声望 → 100 金币', from: 'reputation', fromAmount: 1, to: 'coins', toAmount: 100 },
  { id: 'buyCoreRep', label: '250 声望 → 1 核心', from: 'reputation', fromAmount: 250, to: 'cores', toAmount: 1 },
  { id: 'buyCoreCoins', label: '50000 金币 → 1 核心', from: 'coins', fromAmount: 50000, to: 'cores', toAmount: 1 },
  { id: 'buyRepCoins', label: '200 金币 → 1 声望', from: 'coins', fromAmount: 200, to: 'reputation', toAmount: 1 },
];

/** 货币兑换整体解锁门槛 */
export const EXCHANGE_UNLOCK = { reputation: 20, level: 2 };

/**
 * 科研所：6 条研究线，各 5 级。
 * material 为消耗的科研材料；lineUnlock 为整条研究线的解锁门槛。
 * levels[i] 为升到 i+1 级的花费。
 */
export const RESEARCH = {
  ballistics: {
    id: 'ballistics',
    name: '弹道研究',
    desc: '备弹上限 +20% · 换弹速度 +5% / 级',
    material: 'researchAmmo',
    unlock: { reputation: 40, level: 5, attr: { dmg: 3 } },
    levels: [
      { coins: 200, material: 1 },
      { coins: 350, material: 2 },
      { coins: 550, material: 3 },
      { coins: 800, material: 5, bossCore: 1 },
      { coins: 1200, material: 8, bossCore: 1, map: 'mapYard' },
    ],
    step: { coins: 500, material: 4, bossCore: 1 },
    effects: { ammoCapMul: 0.2, reloadCutMul: 0.05 },
  },
  firepower: {
    id: 'firepower',
    name: '火力研究',
    desc: '武器伤害 +2% · 暴击率 +2% / 级',
    material: 'researchCombat',
    unlock: { reputation: 60, level: 8, attr: { dmg: 5 } },
    levels: [
      { coins: 250, material: 1 },
      { coins: 400, material: 2 },
      { coins: 600, material: 3 },
      { coins: 900, material: 5, bossCore: 1 },
      { coins: 1400, material: 8, bossCore: 1, map: 'mapDock' },
    ],
    step: { coins: 500, material: 4, bossCore: 1 },
    effects: { dmgMul: 0.02, critChance: 0.02 },
  },
  survival: {
    id: 'survival',
    name: '生存研究',
    desc: '最大生命 +8 · 最大护甲 +4 / 级',
    material: 'researchLogistics',
    unlock: { reputation: 40, level: 6, attr: { hp: 3 } },
    levels: [
      { coins: 200, material: 1 },
      { coins: 350, material: 2 },
      { coins: 550, material: 3 },
      { coins: 800, material: 5, bossCore: 1 },
      { coins: 1200, material: 8, bossCore: 1, map: 'mapGarage' },
    ],
    step: { coins: 500, material: 4, bossCore: 1 },
    effects: { hpPerLevel: 8, armorPerLevel: 4 },
  },
  logistics: {
    id: 'logistics',
    name: '后勤研究',
    desc: '敌人掉落率 +8% / 级',
    material: 'researchLogistics',
    unlock: { reputation: 40, level: 6, attr: { speed: 3 } },
    levels: [
      { coins: 200, material: 1 },
      { coins: 350, material: 2 },
      { coins: 550, material: 3 },
      { coins: 800, material: 5, bossCore: 1 },
      { coins: 1200, material: 8, bossCore: 1, map: 'mapLogistics' },
    ],
    step: { coins: 400, material: 3, bossCore: 1 },
    effects: { dropChanceMul: 0.08 },
  },
  weakpoint: {
    id: 'weakpoint',
    name: '弱点研究',
    desc: '爆头伤害 +5% · 首领伤害 +5% / 级',
    material: 'researchCombat',
    unlock: { reputation: 100, level: 12, attr: { dmg: 8 } },
    levels: [
      { coins: 350, material: 2 },
      { coins: 550, material: 3 },
      { coins: 800, material: 4 },
      { coins: 1100, material: 6, bossCore: 1 },
      { coins: 1600, material: 10, bossCore: 2, map: 'mapArena' },
    ],
    step: { coins: 600, material: 5, bossCore: 1 },
    effects: { headshotMul: 0.05, bossMul: 0.05 },
  },
  income: {
    id: 'income',
    name: '收益研究',
    desc: '结算金币 +5% · 经验 +5% / 级',
    material: 'researchAmmo',
    unlock: { reputation: 60, level: 10, attr: { speed: 5 } },
    levels: [
      { coins: 250, material: 1 },
      { coins: 400, material: 2 },
      { coins: 600, material: 3 },
      { coins: 900, material: 5, bossCore: 1 },
      { coins: 1400, material: 8, bossCore: 1, map: 'mapDefense' },
    ],
    step: { coins: 500, material: 4 },
    effects: { coinMul: 0.05, xpMul: 0.05 },
  },
};

/** 研究线顺序（UI 渲染用） */
export const RESEARCH_ORDER = ['ballistics', 'firepower', 'survival', 'logistics', 'weakpoint', 'income'];

/** 汇总科研加成（level 可无限叠加，无上限） */
export function researchTotals(data = {}) {
  const levels = data.research || {};
  const out = {
    ammoCapMul: 1, reloadCut: 0, dmgMul: 1, critChance: 0,
    hpBonus: 0, armorBonus: 0, dropChanceMul: 1,
    headshotMul: 1, bossMul: 1, coinMul: 1, xpMul: 1,
  };
  for (const id of RESEARCH_ORDER) {
    const def = RESEARCH[id];
    const lv = Math.max(0, levels[id] || 0);
    if (!lv) continue;
    const e = def.effects;
    if (e.ammoCapMul) out.ammoCapMul += e.ammoCapMul * lv;
    if (e.reloadCutMul) out.reloadCut += e.reloadCutMul * lv;
    if (e.dmgMul) out.dmgMul += e.dmgMul * lv;
    if (e.critChance) out.critChance += e.critChance * lv;
    if (e.hpPerLevel) out.hpBonus += e.hpPerLevel * lv;
    if (e.armorPerLevel) out.armorBonus += e.armorPerLevel * lv;
    if (e.dropChanceMul) out.dropChanceMul += e.dropChanceMul * lv;
    if (e.headshotMul) out.headshotMul += e.headshotMul * lv;
    if (e.bossMul) out.bossMul += e.bossMul * lv;
    if (e.coinMul) out.coinMul += e.coinMul * lv;
    if (e.xpMul) out.xpMul += e.xpMul * lv;
  }
  return out;
}

/** 机甲额外解锁门槛（声望 / 等级 / 属性点） */
export const MECH_GATES = {
  armor: { reputation: 120, level: 10, attr: { hp: 5 } },
  heavy: { reputation: 200, level: 18, attr: { hp: 10 } },
  turret: { reputation: 60, level: 6, attr: { dmg: 3 } },
};

/** 枪械改装：槽位解锁金币 / 配件制造 / 元素配件声望 */
export const MOD_UNLOCK = {
  slots: {
    muzzle: 800,
    optic: 600,
    magazine: 900,
    grip: 700,
    stock: 700,
  },
  craft: 300,           // 普通配件制造费（金币）
  elementCraft: { coins: 1200, reputation: 150, bossCore: 1 },
};

/** 科研所整体解锁门槛 */
export const RESEARCH_UNLOCK = { reputation: 60, level: 5 };
