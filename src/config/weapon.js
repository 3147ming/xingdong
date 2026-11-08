/**
 * 全局数值配置（v0.3 丧尸生存改造）
 *
 * 与 v0.2 的差异：
 *  - 敌人改为丧尸：普通丧尸只会近战扑咬，**不使用任何枪械**；
 *    另有「吐酸丧尸」进行远程喷吐（非枪械弹道），构成远程威胁。
 *  - 地图改为非封闭式露天货场：无天花板、可见天空，围栏/断墙只做视觉边界，
 *    碰撞边界仍由隐形墙保证玩家与丧尸不出界。
 *  - 新增 SUPPLY 补给点：弹药箱 / 医疗包 / 护甲板 / 综合物资箱，靠近自动拾取，
 *    拾取后进入冷却轮换刷新。
 */

import { CAMPAIGN_WAVES } from './modes.js';

// 玩家参数
export const PLAYER = {
  maxHealth: 100,
  maxArmor: 50,
  eyeHeight: 1.62,        // 相机高度（脚底起算）
  radius: 0.34,           // 水平碰撞半径
  height: 1.75,           // 碰撞体高度
  walkSpeed: 5.4,         // 正常移动
  slowSpeed: 2.4,         // Alt 静步（完全静音）
  sprintSpeed: 8.6,       // Shift 疾跑（快但散布大）
  crouchSpeed: 2.6,       // Ctrl 蹲伏移动速度
  crouchEyeHeight: 1.05,  // 蹲伏时相机高度
  crouchHeight: 1.15,     // 蹲伏时碰撞体高度
  jumpSpeed: 5.8,
  vaultHeight: 2.65,      // 自动翻越的最大高度差（箱体 / 集装箱 / 矮墙）
  vaultLift: 1.8,         // 翻越时的上抛速度
  vaultTime: 0.35,        // 翻越持续时间（期间锁定控制并播放动画）
  vaultPush: 2.6,         // 翻越向前的短冲量，让手感比纯传送更自然
  gravity: -19.0,
  accel: 14.0,            // 地面加速度（越大越跟手）
  airAccel: 3.0,
  friction: 11.0,
  mouseSensitivity: 0.0022,
  hitSlowTime: 0.45,      // 受击僵直持续时间
  hitSlowFactor: 0.45,    // 受击时移动速度倍率
  armorReduction: 1.0,    // 护甲吸收伤害比例（无上限，护甲可叠加至完全吸收）
  respawnDelay: 0.9,
  startPos: { x: 8, y: 0, z: 15 },  // 出生点：货场南侧空地
  startYaw: 0,
};

// 玩家武器参数（对抗丧尸仍用枪械）
// v0.4：多武器系统 —— rifle / pistol / shotgun，按 1/2/3 切换
export const WEAPONS = {
  rifle: {
    id: 'rifle',
    art: 'rifle',
    name: 'M4A1',
    tag: '突击步枪',
    magazineSize: 30,
    reserveAmmo: 120,
    fireInterval: 0.086,    // ≈ 700 RPM
    reloadTime: 2.15,
    damage: 24,
    pellets: 1,             // 单发弹丸
    spread: 0.012,          // 每发弹丸的额外散布（步枪很小）
    headshotMultiplier: 2.0,
    limbMultiplier: 0.5,
    range: 90,
    spreadBase: 0.008,
    spreadMove: 0.022,
    spreadPerShot: 0.0035,
    spreadMax: 0.052,
    spreadRecover: 0.85,
    recoilPitch: 0.0125,
    recoilYaw: 0.0045,
    recoilRecover: 9.0,
    recoilRamp: 0.06,
    recoilRampMax: 2.2,
    shakePerShot: 0.0007,
    shakeMax: 0.004,
    reloadInsertRatio: 0.55,
    auto: true,             // 全自动
    view: {
      scale: 0.60,
      position: { x: 0.14, y: -0.13, z: -0.32 },
      rotation: { x: 0.02, y: Math.PI, z: 0.0 },
      offset: { x: 0, y: 0, z: 0.13 },
    },
  },
  pistol: {
    id: 'pistol',
    art: 'pistol',
    name: 'M1911',
    tag: '手枪',
    magazineSize: 12,
    reserveAmmo: 72,
    fireInterval: 0.18,     // 半自动
    reloadTime: 1.55,
    damage: 34,
    pellets: 1,
    spread: 0.006,
    headshotMultiplier: 2.2,
    limbMultiplier: 0.55,
    range: 70,
    spreadBase: 0.004,
    spreadMove: 0.014,
    spreadPerShot: 0.002,
    spreadMax: 0.035,
    spreadRecover: 0.9,
    recoilPitch: 0.022,
    recoilYaw: 0.008,
    recoilRecover: 14.0,
    recoilRamp: 0.0,
    recoilRampMax: 1.0,
    shakePerShot: 0.0012,
    shakeMax: 0.006,
    reloadInsertRatio: 0.6,
    auto: false,            // 半自动（必须松开再按）
    view: {
      scale: 0.42,
      position: { x: 0.12, y: -0.12, z: -0.28 },
      rotation: { x: 0.0, y: Math.PI, z: 0.0 },
      offset: { x: 0, y: 0, z: 0.13 },
    },
  },
  shotgun: {
    id: 'shotgun',
    art: 'shotgun',
    name: 'M870',
    tag: '霰弹枪',
    magazineSize: 6,
    reserveAmmo: 36,
    fireInterval: 0.72,     // 泵动，慢
    reloadTime: 2.8,
    damage: 16,             // 每颗弹丸伤害
    pellets: 8,             // 8 颗弹丸
    spread: 0.045,          // 散布大
    headshotMultiplier: 1.5,
    limbMultiplier: 0.6,
    range: 38,              // 射程短
    spreadBase: 0.04,
    spreadMove: 0.03,
    spreadPerShot: 0.0,     // 泵动无热累积
    spreadMax: 0.06,
    spreadRecover: 1.0,
    recoilPitch: 0.05,
    recoilYaw: 0.018,
    recoilRecover: 7.0,
    recoilRamp: 0.0,
    recoilRampMax: 1.0,
    shakePerShot: 0.0035,
    shakeMax: 0.012,
    reloadInsertRatio: 0.5,
    auto: false,
    view: {
      scale: 0.66,
      position: { x: 0.17, y: -0.14, z: -0.34 },
      rotation: { x: 0.04, y: Math.PI, z: 0.0 },
      offset: { x: 0, y: 0, z: 0.13 },
    },
  },
  sniper: {
    id: 'sniper',
    art: 'sniper',
    name: 'AWM',
    tag: '重狙击枪',
    magazineSize: 5,
    reserveAmmo: 25,
    fireInterval: 1.35,     // 栓动
    reloadTime: 3.2,
    damage: 200,            // 一枪一个（除 brute 外都是秒）
    pellets: 1,
    pierce: 3,              // 穿透最多 3 个目标
    spread: 0.0,            // 静止时完全无散布
    headshotMultiplier: 2.5,
    limbMultiplier: 0.8,
    range: 180,
    spreadBase: 0.0,
    spreadMove: 0.028,
    spreadPerShot: 0.0,
    spreadMax: 0.025,
    spreadRecover: 1.0,
    recoilPitch: 0.065,
    recoilYaw: 0.022,
    recoilRecover: 6.0,
    recoilRamp: 0.0,
    recoilRampMax: 1.0,
    shakePerShot: 0.005,
    shakeMax: 0.015,
    reloadInsertRatio: 0.5,
    auto: false,
    view: {
      scale: 0.72,
      position: { x: 0.16, y: -0.13, z: -0.36 },
      rotation: { x: 0.0, y: Math.PI, z: 0.0 },
      offset: { x: 0, y: 0, z: 0.13 },
    },
  },
  // 第五把：MP5 冲锋枪（近距离泼水，射速极快、散布大）
  smg: {
    id: 'smg',
    art: 'smg',
    name: 'MP5',
    tag: '冲锋枪',
    magazineSize: 40,
    reserveAmmo: 200,
    fireInterval: 0.0667,   // ≈ 900 RPM
    reloadTime: 1.95,
    damage: 15,
    pellets: 1,
    spread: 0.018,
    headshotMultiplier: 1.8,
    limbMultiplier: 0.5,
    range: 60,
    spreadBase: 0.014,
    spreadMove: 0.026,
    spreadPerShot: 0.005,
    spreadMax: 0.075,
    spreadRecover: 0.95,
    recoilPitch: 0.0085,
    recoilYaw: 0.0042,
    recoilRecover: 11.0,
    recoilRamp: 0.09,
    recoilRampMax: 2.8,
    shakePerShot: 0.0005,
    shakeMax: 0.003,
    reloadInsertRatio: 0.55,
    auto: true,
    view: {
      scale: 0.52,
      position: { x: 0.13, y: -0.12, z: -0.30 },
      rotation: { x: 0.02, y: Math.PI, z: 0.0 },
      offset: { x: 0, y: 0, z: 0.13 },
    },
  },
  // 第六把：RPG-7 火箭筒（单发爆炸 AoE，换弹极慢）
  rpg: {
    id: 'rpg',
    name: 'RPG-7',
    tag: '火箭筒',
    art: 'rpg',             // 使用几何体模型，而不是复用步枪 FBX
    magazineSize: 1,
    reserveAmmo: 4,
    fireInterval: 1.6,
    reloadTime: 3.4,
    damage: 200,
    pellets: 1,
    spread: 0.0,
    headshotMultiplier: 1.0,
    limbMultiplier: 1.0,
    range: 120,
    explodeRadius: 5.5,     // 命中点范围爆炸
    explodeDamage: 120,
    spreadBase: 0.0,
    spreadMove: 0.03,
    spreadPerShot: 0.0,
    spreadMax: 0.03,
    spreadRecover: 1.0,
    recoilPitch: 0.07,
    recoilYaw: 0.025,
    recoilRecover: 5.0,
    recoilRamp: 0.0,
    recoilRampMax: 1.0,
    shakePerShot: 0.006,
    shakeMax: 0.018,
    reloadInsertRatio: 0.5,
    auto: false,
    view: {
      scale: 0.9,
      position: { x: 0.19, y: -0.16, z: -0.36 },
      rotation: { x: 0.02, y: Math.PI, z: 0.0 },
      offset: { x: 0, y: 0, z: 0.2 },
    },
  },
};

// 兼容旧代码：默认武器 = 步枪
export const WEAPON = WEAPONS.rifle;

// 武器切换顺序
export const WEAPON_ORDER = ['rifle', 'pistol', 'shotgun', 'sniper', 'smg', 'rpg'];

// 初始携带的武器
export const WEAPON_UNLOCKED = ['rifle', 'pistol', 'shotgun', 'sniper', 'smg', 'rpg'];

// ---------------- 丧尸（敌人） ----------------
// 铁律：普通丧尸（walker / brute）只有近战，**没有任何枪械参数**。
//      远程威胁只来自「吐酸丧尸」的喷吐（非枪械），单独走 spit 通道。
export const ENEMY = {
  sightRange: 45,         // 视野距离（从 30 提高，丧尸更远就能发现玩家）
  sightCloseRange: 14,    // 近距离全方位感知半径（背后/侧面 14m 以内均会发现）
  sightAngle: Math.cos(Math.PI / 4.3), // 约 ±42°（远距离视野锥，近距离不限制朝向）
  sightLinger: 0.0,       // 发现玩家后的追击延迟：已移除，立即追击
  alertTime: 6.0,         // 失去视野/听到动静后的警戒搜索时间
  hearTime: 4.0,          // 听到枪声/子弹落地后的警觉持续时间
  flinchTime: 0.22,       // 受击抖动时间
  deathBodyTime: 5.0,     // 尸体停留时间
  spawnFadeTime: 0.85,    // 重生渐显时长（太短会像"凭空闪现"，拉长一点更自然）
  turnSpeed: 4.5,         // 转头速度略降，避免瞬间锁头像瞬移
  radius: 0.4,
  height: 1.8,
  bodyHeight: 0.95,       // 身体命中球中心高度
  bodyRadius: 0.42,
  headHeight: 1.66,
  headRadius: 0.22,

  // 丧尸变体
  types: {
    // 普通丧尸：缓慢逼近，近战扑咬
    walker: {
      id: 'walker',
      name: '普通丧尸',
      maxHealth: 90,
      patrolSpeed: 1.5,
      chaseSpeed: 2.7,      // 追击速度略低于玩家步行，给玩家换弹与走位窗口
      damage: 11,           // 爪击/撕咬
      attackRange: 2.15,    // 近战触及距离
      attackInterval: 1.25, // 两次攻击间隔
      windup: 0.42,         // 抬手到判定的前摇
      keepDistance: 1.35,
      melee: true,
      scaleMul: 1.0,
      tint: 0x9aa878,
    },
    // 吐酸丧尸：中距离喷吐酸液（非枪械）
    spitter: {
      id: 'spitter',
      name: '吐酸丧尸',
      maxHealth: 70,
      patrolSpeed: 1.3,
      chaseSpeed: 2.4,
      damage: 8,
      attackRange: 17,
      attackInterval: 2.1,
      keepDistance: 8.5,
      accuracy: 0.55,
      accuracyMin: 0.15,
      accuracyRange: 30,
      melee: false,
      scaleMul: 0.94,
      tint: 0xaec24e,
    },
    // 重锤丧尸：慢但耐打，近战重击
    brute: {
      id: 'brute',
      name: '重锤丧尸',
      maxHealth: 190,        // 重狙身体一枪可带走（200 伤害）
      patrolSpeed: 1.2,
      chaseSpeed: 2.2,
      damage: 22,
      attackRange: 2.6,
      attackInterval: 1.75,
      windup: 0.55,
      keepDistance: 1.6,
      melee: true,
      scaleMul: 1.18,
      tint: 0x8a6a52,
    },
    // 迅捷丧尸：高速低血，快速突进近战
    swift: {
      id: 'swift',
      name: '迅捷丧尸',
      maxHealth: 48,
      patrolSpeed: 2.2,
      chaseSpeed: 3.9,       // 仍然最快，但不至于瞬间贴脸
      damage: 8,
      attackRange: 1.9,
      attackInterval: 0.9,
      windup: 0.22,
      keepDistance: 1.0,
      melee: true,
      scaleMul: 0.88,
      tint: 0xc8b87a,
    },
    // 自爆丧尸：靠近玩家后倒计时自爆，范围伤害
    bomber: {
      id: 'bomber',
      name: '自爆丧尸',
      maxHealth: 60,
      patrolSpeed: 1.25,
      chaseSpeed: 2.4,
      damage: 45,
      attackRange: 3.2,
      attackInterval: 3.5,
      windup: 0.0,
      keepDistance: 1.2,
      melee: false,
      bomber: true,
      explodeRadius: 4.2,
      fuseTime: 0.85,
      scaleMul: 1.05,
      tint: 0xb85a3a,
    },
    // 首领：高血量近战重击，体型明显更大（无尽每 10 波出场）
    boss: {
      id: 'boss',
      name: '巨型丧尸',
      maxHealth: 800,        // 重狙约 4 枪（身体），成长后可压到 2-3 枪
      patrolSpeed: 1.1,
      chaseSpeed: 2.0,
      damage: 34,
      attackRange: 3.0,
      attackInterval: 1.5,
      windup: 0.55,
      keepDistance: 2.0,
      melee: true,
      scaleMul: 1.55,
      tint: 0x7a2f3a,
    },
    // 奔跑者：血薄速极快，直线冲刺近战，成群出现
    runner: {
      id: 'runner',
      name: '奔跑者',
      maxHealth: 30,
      patrolSpeed: 2.5,
      chaseSpeed: 6.75,          // 普通丧尸的2.5倍
      damage: 10,
      attackRange: 1.8,
      attackInterval: 0.8,
      windup: 0.15,
      keepDistance: 0.9,
      melee: true,
      runner: true,              // 标记：启用直线冲刺AI
      scaleMul: 0.82,
      tint: 0x5aa05a,            // 绿色皮肤，瘦长
    },
    // 胖子/爆破者：血厚速很慢，死亡后延时爆炸+毒雾
    fat: {
      id: 'fat',
      name: '胖子',
      maxHealth: 200,
      patrolSpeed: 0.9,
      chaseSpeed: 1.5,
      damage: 25,
      attackRange: 2.4,
      attackInterval: 1.8,
      windup: 0.6,
      keepDistance: 1.5,
      melee: true,
      fat: true,                 // 标记：死亡后爆炸
      explodeRadius: 5.0,
      explodeDamage: 80,
      fuseTime: 3.0,             // 死亡后3秒爆炸
      poisonTime: 5.0,           // 毒雾持续5秒
      scaleMul: 1.35,
      tint: 0xf06a2a,            // 橙色皮肤，肥胖
    },
    // 嚎叫者：发现玩家后嘶吼，触发周围所有丧尸警觉
    howler: {
      id: 'howler',
      name: '嚎叫者',
      maxHealth: 75,
      patrolSpeed: 1.4,
      chaseSpeed: 2.4,
      damage: 8,
      attackRange: 2.1,
      attackInterval: 2.5,
      windup: 0.5,
      keepDistance: 2.0,
      melee: true,
      howler: true,
      scaleMul: 1.02,
      tint: 0x8877cc,
    },
  },

  spawnPoints: [
    { x: -20, z: -14 },
    { x: 20, z: -14 },
    { x: -22, z: 10 },
    { x: 22, z: 10 },
    { x: -16, z: -20 },
    { x: 16, z: -20 },
    { x: 0, z: -18 },
    { x: -24, z: -2 },
    { x: 24, z: -2 },
    { x: 8, z: 18 },
  ],
  patrolPoints: [
    { x: -20, z: -14 }, { x: -8, z: -17 }, { x: 8, z: -16 },
    { x: 20, z: -14 }, { x: 21, z: 2 }, { x: 14, z: 12 },
    { x: 0, z: 8 }, { x: -14, z: 12 }, { x: -21, z: 2 }, { x: 0, z: -6 },
    { x: -10, z: 16 }, { x: 10, z: 16 },
  ],
};

// 一局任务：三波尸潮，清空即区域肃清
// 波次配置已迁移到 config/modes.js（P0 拆分），这里保留引用以兼容现有调用方
export const MATCH = {
  waves: CAMPAIGN_WAVES,
  breakTime: 5.0,        // 两波之间的休整时间（秒）
  spawnGap: 0.7,         // 同波内补位刷新的最小间隔
  minSpawnDist: 13,      // 出生点与玩家的最小距离
  fallbackSpawnDist: 8,  // 所有出生点都太近时的兜底距离
  waveClearAmmo: 60,     // 每波肃清补给：备弹（守城）
  waveClearAmmoSmall: 15, // 闯关 / 无尽：小量免费补给（弹药主要靠购买与掉落）
  waveClearArmor: 20,    // 每波肃清补给：护甲
  grades: [
    { grade: 'S', min: 2400 },
    { grade: 'A', min: 1900 },
    { grade: 'B', min: 1400 },
    { grade: 'C', min: 0 },
  ],
};

// ---------------- 补给点（资源点 / 弹药 / 物资） ----------------
export const SUPPLY = {
  pickupRadius: 1.7,     // 靠近自动拾取的半径
  respawnSec: 24,        // 被拾取后重新刷新的时间
  types: {
    ammo:  { label: '弹药箱', hint: '+90 发备弹',   ammo: 90,  heal: 0,  armor: 0,  color: 0x4f7a3a },
    ammoSmall: { label: '弹药包', hint: '+10 发备弹', ammo: 10, heal: 0,  armor: 0,  color: 0x5d8a45 },
    med:   { label: '医疗包', hint: '+45 生命',     ammo: 0,   heal: 45, armor: 0,  color: 0xb43a34 },
    armor: { label: '护甲板', hint: '+35 护甲',     ammo: 0,   heal: 0,  armor: 35, color: 0x3a5fb4 },
    cache: { label: '物资箱', hint: '+60 弹药 +30 生命 +25 护甲 · 随机投掷物×1', ammo: 60, heal: 30, armor: 25, throwable: 1, color: 0xb8862e },
  },
  // 地图上的补给点位（露天货场坐标）
  points: [
    { type: 'ammo',  x: -16, z: -10 },
    { type: 'ammo',  x: 14,  z: -12 },
    { type: 'ammo',  x: -2,  z: 12 },
    { type: 'med',   x: -20, z: 6 },
    { type: 'med',   x: 18,  z: 4 },
    { type: 'armor', x: -8,  z: -2 },
    { type: 'armor', x: 10,  z: 14 },
    { type: 'cache', x: 0,   z: -8 },
    { type: 'cache', x: -22, z: -18 },
    { type: 'cache', x: 22,  z: -18 },
  ],
};

// ---------------- 击杀掉落表 ----------------
// 按变体配置不同掉落概率与必掉项；局内死亡时由 SupplyManager.spawnDrop 吐出来
export const DROP = {
  // 掉落物在地面存在的时间（秒）
  lifetime: 30,
  // 每只敌人死亡时的掉落表
  // 普通敌人只掉"小弹药包"（10 发），避免免费弹药冲垮局外弹药经济
  byType: {
    walker: {
      drops: [
        { type: 'ammoSmall', chance: 0.20 },
        { type: 'med',       chance: 0.15 },
      ],
    },
    swift: {
      drops: [
        { type: 'ammoSmall', chance: 0.22 },
        { type: 'med',       chance: 0.12 },
      ],
    },
    brute: {
      drops: [
        { type: 'ammoSmall', chance: 0.35 },
        { type: 'armor',     chance: 0.55 },
        { type: 'med',       chance: 0.4 },
      ],
    },
    spitter: {
      drops: [
        { type: 'ammoSmall', chance: 0.18 },
        { type: 'med',       chance: 0.22 },
      ],
    },
    bomber: {
      drops: [
        { type: 'ammoSmall', chance: 0.22 },
      ],
    },
    howler: {
      drops: [
        { type: 'med',       chance: 0.55 },
        { type: 'ammoSmall', chance: 0.2 },
      ],
    },
    // 首领级：必掉综合物资箱 + 医疗 + 护甲 + 一箱完整弹药
    boss: {
      drops: [
        { type: 'cache', chance: 1.0 },
        { type: 'med',   chance: 1.0 },
        { type: 'armor', chance: 1.0 },
        { type: 'ammo',  chance: 1.0 },
      ],
    },
  },
};

// 地图参数（非封闭式露天货场）
export const WORLD = {
  halfX: 28,
  halfZ: 22,
  wallHeight: 7.2,        // 隐形边界高度（防止跳出地图）
  fenceHeight: 1.55,      // 视觉围栏高度（远低于墙，天空可见 = 非封闭）
  floorY: 0,
  skyTop: 0x5f92cf,
  skyBottom: 0xd7e4ee,
  fogColor: 0xb9c9d6,
  fogNear: 46,
  fogFar: 175,
};
