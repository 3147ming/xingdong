/**
 * Roguelike 三选一 Perk 配置（局内永久增益，本局结束后清空）
 *
 * 叠加规则：同类 perk 全部线性叠加（延续"无上限"思路），
 * 仅时间减缓设 70% 安全上限（避免敌人时间流速趋近 0 导致画面卡死）。
 *
 * apply(m, n)：m 为累积增益对象，n 为该 perk 当前总层数（含本次）。
 */

export const PERK_CATEGORY_LABEL = {
  attack: '攻击',
  survival: '生存',
  special: '特殊',
};

/** 增益对象初始值（PerkSystem 每次重建时使用） */
export function emptyPerkMods() {
  return {
    dmgAdd: 0,            // 伤害加成（加法，0.25 = +25%）
    fireRateAdd: 0,       // 射速加成
    magAdd: 0,            // 弹匣容量加成
    pierceAdd: 0,         // 额外穿透数
    explodeRadius: 0,     // 每发子弹小范围爆炸半径
    explodeDamage: 0,     // 该爆炸伤害
    critAdd: 0,           // 暴击率加成
    critMul: 1.6,         // 暴击倍率（选到暴击 perk 后提升到 3）
    hpAdd: 0,             // 最大生命加成
    armorAdd: 0,          // 最大护甲加成
    killHeal: 0,          // 每次击杀回血
    speedAdd: 0,          // 移速加成
    slowResist: 0,        // 受击僵直减免（1 = 完全免疫）
    extraPellets: 0,      // 每发额外弹丸（双重射击）
    bounceAdd: 0,         // 弹射次数
    slowMoAdd: 0,         // 开枪时周围时间减缓比例
  };
}

export const PERK_DEFS = [
  // ---------------- 攻击 ----------------
  {
    id: 'damage', name: '高爆弹药', cat: 'attack', icon: '伤',
    desc: '所有武器伤害 +25%',
    apply: (m, n) => { m.dmgAdd += 0.25 * n; },
  },
  {
    id: 'fireRate', name: '过载机匣', cat: 'attack', icon: '速',
    desc: '射速 +20%',
    apply: (m, n) => { m.fireRateAdd += 0.20 * n; },
  },
  {
    id: 'magazine', name: '扩容供弹', cat: 'attack', icon: '匣',
    desc: '弹匣容量 +50%',
    apply: (m, n) => { m.magAdd += 0.50 * n; },
  },
  {
    id: 'pierce', name: '穿甲弹芯', cat: 'attack', icon: '穿',
    desc: '子弹可多穿透 3 个敌人',
    max: 3,
    apply: (m, n) => { m.pierceAdd += 3 * n; },
  },
  {
    id: 'explosive', name: '爆裂弹头', cat: 'attack', icon: '爆',
    desc: '每发子弹命中后小范围爆炸',
    max: 5,
    apply: (m, n) => {
      m.explodeRadius = 1.6 + (n - 1) * 0.25;
      m.explodeDamage = 25 * n;
    },
  },
  {
    id: 'crit', name: '致命弱点', cat: 'attack', icon: '暴',
    desc: '暴击率 +30%，暴击伤害提升至 3 倍',
    max: 4,
    apply: (m, n) => { m.critAdd += 0.30 * n; m.critMul = 3; },
  },

  // ---------------- 生存 ----------------
  {
    id: 'maxHp', name: '强化体质', cat: 'survival', icon: '血',
    desc: '最大生命 +25（立即补满该部分）',
    apply: (m, n) => { m.hpAdd += 25 * n; },
  },
  {
    id: 'maxArmor', name: '复合装甲', cat: 'survival', icon: '甲',
    desc: '最大护甲 +25（立即补满该部分）',
    apply: (m, n) => { m.armorAdd += 25 * n; },
  },
  {
    id: 'killHeal', name: '嗜血', cat: 'survival', icon: '愈',
    desc: '每次击杀回复 2 点生命',
    apply: (m, n) => { m.killHeal += 2 * n; },
  },
  {
    id: 'speed', name: '轻装疾行', cat: 'survival', icon: '移',
    desc: '移动速度 +15%',
    apply: (m, n) => { m.speedAdd += 0.15 * n; },
  },
  {
    id: 'stagger', name: '稳如磐石', cat: 'survival', icon: '抗',
    desc: '受击僵直减少 50%',
    apply: (m, n) => { m.slowResist += 0.5 * n; },
  },

  // ---------------- 特殊 ----------------
  {
    id: 'doubleShot', name: '双重射击', cat: 'special', icon: '双',
    desc: '每次开火额外射出一颗弹丸',
    max: 3,
    apply: (m, n) => { m.extraPellets += 1 * n; },
  },
  {
    id: 'bounce', name: '弹射子弹', cat: 'special', icon: '射',
    desc: '命中后向附近敌人弹射 2 次（60% 伤害）',
    max: 3,
    apply: (m, n) => { m.bounceAdd += 2 * n; },
  },
  {
    id: 'slowMo', name: '子弹时间', cat: 'special', icon: '缓',
    desc: '开枪后周围时间变慢 20%（持续 1.2 秒）',
    max: 3,
    apply: (m, n) => { m.slowMoAdd += 0.20 * n; },
  },
];

/** 时间减缓安全上限（叠加到此值后不再增加实际效果） */
export const SLOWMO_CAP = 0.7;
