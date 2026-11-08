/**
 * 枪械改装 / 元素弹 / 弹种配置
 *
 * 改装采用多槽位：枪口、瞄具、弹匣、握把、枪托。
 *  - 枪口决定子弹元素（风 / 火 / 雷 / 电 / 毒 / 连爆）；
 *  - 瞄具影响开镜倍率、开镜灵敏度与散布；
 *  - 弹匣 / 握把 / 枪托影响容量、换弹、散布与后坐力。
 *
 * 所有改装只做纯数据计算，GunSystem 读取 deriveWeapon() 的结果。
 */
import { WEAPONS } from './weapon.js';

/** 五个改装槽位 */
export const MOD_SLOTS = [
  { id: 'muzzle', name: '枪口', hint: '赋予子弹元素效果' },
  { id: 'optic', name: '瞄具', hint: '开镜倍率与精度' },
  { id: 'magazine', name: '弹匣', hint: '弹匣容量与换弹' },
  { id: 'grip', name: '握把', hint: '移动散布与后坐' },
  { id: 'stock', name: '枪托', hint: '后坐力控制' },
];

/** 元素词条：实际效果由 GunSystem 结算 */
export const ELEMENTS = {
  none: { name: '无', color: 0xffffff },
  wind: { name: '风', color: 0xaee9ff, knockback: 7, desc: '命中击退丧尸' },
  fire: { name: '火', color: 0xff7a2a, burnDps: 10, burnTime: 3.0, desc: '附带 3 秒灼烧' },
  lightning: { name: '雷', color: 0xffe066, chainCount: 2, chainRange: 6.5, chainMul: 0.5, desc: '闪电连锁 2 个目标' },
  electric: { name: '电', color: 0x66d9ff, slowFactor: 0.5, slowTime: 2.4, desc: '麻痹减速 50%' },
  poison: { name: '毒', color: 0x9be34a, poisonDps: 7, poisonTime: 5.0, desc: '附带 5 秒毒伤' },
  combo: { name: '连爆', color: 0xff4d6d, comboHits: 4, explodeRadius: 4.0, explodeDamage: 80, desc: '每 4 次命中引发爆炸' },
};

/** 弹药类型：局内 Ctrl+R 轮盘切换 */
export const AMMO_TYPES = [
  { id: 'standard', name: '标准弹', color: 0xffd27a, desc: '均衡弹种', damageMul: 1.0, spreadMul: 1.0 },
  { id: 'ap', name: '穿甲弹', color: 0xbfe2ff, desc: '多穿透 1 个目标', damageMul: 1.1, spreadMul: 1.0, pierceAdd: 1 },
  { id: 'hollow', name: '空尖弹', color: 0xffb36b, desc: '伤害 +25%，散布略增', damageMul: 1.25, spreadMul: 1.15 },
  { id: 'explosive', name: '爆裂弹', color: 0xff7a45, desc: '命中产生小范围爆炸', damageMul: 0.95, spreadMul: 1.05, explodeRadius: 2.6, explodeDamage: 30 },
];

/** 各武器基础开镜参数（瞄具会再乘系数） */
const WEAPON_ADS = {
  rifle: { fov: 55, sensMul: 0.65, spreadMul: 0.55 },
  pistol: { fov: 58, sensMul: 0.7, spreadMul: 0.6 },
  shotgun: { fov: 62, sensMul: 0.75, spreadMul: 0.7 },
  sniper: { fov: 28, sensMul: 0.32, spreadMul: 0.25 },
  smg: { fov: 60, sensMul: 0.7, spreadMul: 0.55 },
  rpg: { fov: 66, sensMul: 0.8, spreadMul: 0.7 },
};

const ELEMENT_MUZZLES = [
  ['wind', '风压制退器', 1.02, '命中把丧尸击退，弹道更稳'],
  ['fire', '烈焰消焰器', 1.03, '子弹附带灼烧持续伤害'],
  ['lightning', '雷霆补偿器', 1.02, '命中后闪电连锁附近目标'],
  ['electric', '电磁脉冲器', 1.03, '命中使目标麻痹减速'],
  ['poison', '剧毒喷射阀', 1.04, '子弹附带剧毒持续伤害'],
  ['combo', '连爆导气箍', 1.05, '每 4 次命中触发范围爆炸'],
];

function elementAttachments(slot) {
  return ELEMENT_MUZZLES.map(([element, name, damageMul, desc]) => ({
    id: `muzzle_${element}`,
    slot,
    name,
    desc,
    element,
    stats: { damageMul },
  }));
}

/** 每个槽位的可选配件（首项永远是"无改装"） */
export const ATTACHMENTS = {
  muzzle: [
    { id: 'none', slot: 'muzzle', name: '无改装', desc: '标准枪口', stats: {} },
    ...elementAttachments('muzzle'),
  ],
  optic: [
    { id: 'none', slot: 'optic', name: '无改装', desc: '机械瞄具', stats: {} },
    { id: 'reddot', slot: 'optic', name: '红点镜', desc: '开镜更快，散布 -12%', stats: { spreadMul: 0.88, adsFovMul: 0.9, adsSensMul: 0.9 } },
    { id: 'scope', slot: 'optic', name: '4 倍镜', desc: '高倍开镜，散布 -25%', stats: { spreadMul: 0.75, adsFovMul: 0.5, adsSensMul: 0.75 } },
  ],
  magazine: [
    { id: 'none', slot: 'magazine', name: '无改装', desc: '标准弹匣', stats: {} },
    { id: 'ext', slot: 'magazine', name: '扩容弹匣', desc: '容量 +50%，换弹稍慢', stats: { magMul: 1.5, reloadMul: 1.12 } },
    { id: 'drum', slot: 'magazine', name: '弹鼓', desc: '容量 +100%，换弹更慢', stats: { magMul: 2.0, reloadMul: 1.3 } },
  ],
  grip: [
    { id: 'none', slot: 'grip', name: '无改装', desc: '标准握把', stats: {} },
    { id: 'vertical', slot: 'grip', name: '垂直握把', desc: '散布 -15%，后坐 -8%', stats: { spreadMul: 0.85, recoilMul: 0.92 } },
    { id: 'angled', slot: 'grip', name: '斜角握把', desc: '散布 -10%，后坐 -12%', stats: { spreadMul: 0.9, recoilMul: 0.88 } },
  ],
  stock: [
    { id: 'none', slot: 'stock', name: '无改装', desc: '标准枪托', stats: {} },
    { id: 'light', slot: 'stock', name: '轻型枪托', desc: '后坐 -18%', stats: { recoilMul: 0.82, spreadMul: 0.98 } },
    { id: 'heavy', slot: 'stock', name: '重型枪托', desc: '后坐 -30%，换弹稍慢', stats: { recoilMul: 0.7, reloadMul: 1.05 } },
  ],
};

/** 取某槽位的配件定义 */
export function getAttachment(slotId, attachmentId) {
  const list = ATTACHMENTS[slotId] || [];
  return list.find((a) => a.id === attachmentId) || list[0];
}

/** 新存档：所有武器所有槽位均为"无改装" */
export function defaultLoadout() {
  const out = {};
  for (const id of Object.keys(WEAPONS)) {
    out[id] = {};
    for (const slot of MOD_SLOTS) out[id][slot.id] = 'none';
  }
  return out;
}

/** 过滤脏数据：非法武器 / 槽位 / 配件一律回落到"无改装" */
export function normalizeLoadout(src = {}) {
  const base = defaultLoadout();
  if (!src || typeof src !== 'object') return base;
  for (const weaponId of Object.keys(base)) {
    const saved = src[weaponId];
    if (!saved || typeof saved !== 'object') continue;
    for (const slot of MOD_SLOTS) {
      const att = getAttachment(slot.id, saved[slot.id]);
      base[weaponId][slot.id] = att ? att.id : 'none';
    }
  }
  return base;
}

/**
 * 把基础武器 + 改装合成实际使用的武器数据
 * @param {object} base WEAPONS[id]
 * @param {{[slot:string]: string}} loadout 该武器的槽位配置
 */
export function deriveWeapon(base, loadout = {}) {
  const stats = {
    damageMul: 1, spreadMul: 1, recoilMul: 1, magMul: 1, reloadMul: 1,
    adsFovMul: 1, adsSensMul: 1,
  };
  let element = 'none';

  for (const slot of MOD_SLOTS) {
    const att = getAttachment(slot.id, loadout[slot.id]);
    if (!att) continue;
    if (att.element) element = att.element;
    const s = att.stats || {};
    for (const key of Object.keys(stats)) {
      if (typeof s[key] === 'number') stats[key] *= s[key];
    }
  }

  const ads = WEAPON_ADS[base.id] || { fov: 58, sensMul: 0.65, spreadMul: 0.55 };

  return {
    ...base,
    damage: base.damage * stats.damageMul,
    spreadBase: base.spreadBase * stats.spreadMul,
    spreadMove: base.spreadMove * stats.spreadMul,
    spreadPerShot: base.spreadPerShot * stats.spreadMul,
    spreadMax: base.spreadMax * stats.spreadMul,
    recoilPitch: base.recoilPitch * stats.recoilMul,
    recoilYaw: base.recoilYaw * stats.recoilMul,
    magazineSize: Math.max(1, Math.round(base.magazineSize * stats.magMul)),
    reloadTime: base.reloadTime * stats.reloadMul,
    adsFov: ads.fov * stats.adsFovMul,
    adsSensMul: ads.sensMul * stats.adsSensMul,
    adsSpreadMul: ads.spreadMul,
    element,
  };
}
