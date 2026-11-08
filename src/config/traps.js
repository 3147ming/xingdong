/**
 * 陷阱与炮塔配置（波间商店购买 → 手持蓝图 → 按 F 放置）
 *
 * 四种装置：
 *  - mine   阔剑地雷：丧尸靠近即引爆，范围伤害 150
 *  - flame  火焰陷阱：丧尸靠近时喷火，持续灼烧
 *  - shock  电网：持续通电，范围内丧尸被麻痹
 *  - turret 自动炮塔：360° 索敌自动射击
 *
 * 所有装置都有生命值，丧尸贴身会拆掉它。
 */
export const TRAPS = {
  mine: {
    id: 'mine',
    name: '阔剑地雷',
    price: 100,
    hp: 60,
    desc: '丧尸靠近即引爆，150 范围伤害',
    triggerRadius: 2.2,
    radius: 4.5,
    damage: 150,
    color: 0x5a6b3a,
  },
  flame: {
    id: 'flame',
    name: '火焰陷阱',
    price: 150,
    hp: 70,
    desc: '丧尸靠近时喷火，持续灼烧区域',
    triggerRadius: 2.4,
    radius: 3.2,
    dps: 40,
    duration: 2.5,
    cooldown: 1.6,
    color: 0xb8542a,
  },
  shock: {
    id: 'shock',
    name: '电网',
    price: 200,
    hp: 90,
    desc: '通电栅栏，范围内丧尸麻痹 2 秒',
    triggerRadius: 3.6,
    stun: 2.0,
    color: 0x2e7fa8,
  },
  turret: {
    id: 'turret',
    name: '自动炮塔',
    price: 500,
    hp: 120,
    desc: '自动索敌射击，360° 伤害 20/发',
    radius: 14,
    damage: 20,
    fireInterval: 0.45,
    color: 0x5b646e,
  },
};

export const TRAP_ORDER = ['mine', 'flame', 'shock', 'turret'];
