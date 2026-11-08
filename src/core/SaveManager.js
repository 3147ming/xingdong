/**
 * 本地存档（localStorage）
 *
 * 只做"读 / 写 / 合并 / 重置"，不含任何游戏逻辑。
 * 局外成长（天赋、永久属性、机甲解锁、战绩）都从这里进出，
 * 后续 P3/P4/P5 直接读写这个对象，不要再各自散写 localStorage。
 */

import { DEFAULT_BINDS } from '../config/keybinds.js';
import { defaultLoadout, getAttachment, ATTACHMENTS } from '../config/mods.js';
import { MISSIONS, calcRunRewards, missionProgress } from '../config/economy.js';
import { ATTRIBUTES, LEVEL, MECHS, talentCost, runXp, xpToNext } from '../config/growth.js';
import {
  MATERIALS, MATERIAL_SHOP, AMMO_SHOP, EXCHANGE_OPS, EXCHANGE_UNLOCK,
  RESEARCH, RESEARCH_ORDER, RESEARCH_UNLOCK, researchTotals,
  MOD_UNLOCK, MECH_GATES, materialPrice,
} from '../config/progression.js';

export const SAVE_KEY = 'warehouse-strike.save.v1';
export const SAVE_VERSION = 1;

/** 全新存档的默认结构 */
export function defaultSave() {
  return {
    v: SAVE_VERSION,
    meta: {
      cores: 0,
      coins: 0,
      reputation: 0,
      materials: {
        awaken: 0,
        mecha: 0,
        researchAmmo: 0,
        researchCombat: 0,
        researchLogistics: 0,
        bossCore: 0,
        mapYard: 0,
        mapDock: 0,
        mapGarage: 0,
        mapLogistics: 0,
        mapArena: 0,
        mapDefense: 0,
      },
      claimedMissions: [],
      // 局外备弹库存（按武器口径；闯关/无尽开局带入）
      // 新兵配发：够打第一局，之后需要采购或捡掉落
      ammoStock: { rifle: 60, pistol: 30, shotgun: 18, sniper: 10, smg: 80, rpg: 2 },
      // 材料采购累计次数（价格递增）
      shopBuys: {},
    },
    talents: { atk: 0, def: 0, mob: 0 },
    permanent: { hp: 0, dmg: 0, armor: 0, speed: 0 },
    progress: { level: 1, xp: 0, points: 0 },
    unlocks: {
      mechs: [],
      weapons: ['rifle', 'pistol', 'shotgun', 'sniper', 'smg', 'rpg'],
      levels: 1,
      modSlots: [],
      attachments: [],
      // 一次性解锁权限（声望门槛达成后永久保留，避免扣声望后倒退）
      features: [],
    },
    // 科研等级（6 条线，各 0~5）
    research: {
      ballistics: 0,
      firepower: 0,
      survival: 0,
      logistics: 0,
      weakpoint: 0,
      income: 0,
    },
    stats: { runs: 0, kills: 0, bestLevel: 1, bestWave: 0, totalTime: 0 },
    loadout: defaultLoadout(),
    settings: {
      sens: 0.0022,
      vol: 1.0,
      autoPickup: true,
      binds: { ...DEFAULT_BINDS },
    },
  };
}

/** 深合并：只保留默认结构里存在的键，避免旧存档 / 脏数据污染 */
function mergeDefaults(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(target)) {
    const def = target[key];
    const val = source[key];
    if (val === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(val)) target[key] = val.slice();
    } else if (def && typeof def === 'object') {
      target[key] = mergeDefaults({ ...def }, val);
    } else if (typeof val === typeof def) {
      target[key] = val;
    }
  }
  return target;
}

export class SaveManager {
  /**
   * @param {Storage|null} storage 可注入，方便单测；浏览器里默认用 localStorage
   */
  constructor(storage = null) {
    this.storage = storage || SaveManager._pickStorage();
    this.data = this.load();
  }

  static _pickStorage() {
    try {
      const s = globalThis.localStorage;
      if (s) return s;
    } catch (e) {
      // 隐私模式 / 沙箱环境可能直接抛错
    }
    return null;
  }

  /** 读取存档；损坏或不存在时返回默认值 */
  load() {
    const base = defaultSave();
    if (!this.storage) return base;
    try {
      const raw = this.storage.getItem(SAVE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== SAVE_VERSION) return base;
      const merged = mergeDefaults(base, parsed);
      // 旧存档迁移：单一 research 材料 → 弹道研究数据
      const legacyResearch = parsed?.meta?.materials?.research;
      if (typeof legacyResearch === 'number' && legacyResearch > 0) {
        merged.meta.materials.researchAmmo += legacyResearch;
      }
      return merged;
    } catch (e) {
      return base;
    }
  }

  /** 写入当前内存中的数据；存储不可用时静默失败（游戏照常可玩） */
  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(this.data));
      return true;
    } catch (e) {
      return false;
    }
  }

  reset() {
    this.data = defaultSave();
    return this.save();
  }

  /** 修改单项设置（灵敏度 / 音量 / 自动拾取）并保存 */
  setSetting(key, value) {
    if (!(key in this.data.settings)) return false;
    this.data.settings[key] = value;
    return this.save();
  }

  /** 改键：把某个动作绑定到指定按键编码 */
  setBind(action, code) {
    if (!(action in this.data.settings.binds)) return false;
    this.data.settings.binds[action] = code;
    return this.save();
  }

  /** 恢复默认键位 */
  resetBinds() {
    this.data.settings.binds = { ...DEFAULT_BINDS };
    return this.save();
  }

  /** 改装：把某武器某槽位换成指定配件 */
  setMod(weaponId, slotId, attachmentId) {
    const slots = this.data.loadout[weaponId];
    if (!slots || !(slotId in slots)) return false;
    const att = getAttachment(slotId, attachmentId);
    slots[slotId] = att ? att.id : 'none';
    return this.save();
  }

  /** 一键卸下所有改装 */
  resetLoadout() {
    this.data.loadout = defaultLoadout();
    return this.save();
  }

  /** 局外素材：丧尸核心 */
  addCores(n) {
    this.data.meta.cores = Math.max(0, (this.data.meta.cores || 0) + n);
    this.save();
  }

  /** 统一发放奖励（金币 / 声望 / 核心 / 材料），返回实际发放明细 */
  _grantReward(reward = {}) {
    const meta = this.data.meta;
    const coins = reward.coins || 0;
    const reputation = reward.reputation || 0;
    const cores = reward.cores || 0;
    const materials = {};
    meta.coins += coins;
    meta.reputation += reputation;
    meta.cores += cores;
    if (reward.materials) {
      for (const [key, value] of Object.entries(reward.materials)) {
        if (!(key in meta.materials)) continue;
        meta.materials[key] += value;
        materials[key] = value;
      }
    }
    return { coins, reputation, cores, materials };
  }

  /** 消费金币 / 声望 / 材料；任一项余额不足时返回 false 且不扣款 */
  spend({ coins = 0, reputation = 0, materials = null } = {}) {
    const meta = this.data.meta;
    if (meta.coins < coins || meta.reputation < reputation) return false;
    if (materials) {
      for (const [key, value] of Object.entries(materials)) {
        if (!(key in meta.materials) || meta.materials[key] < value) return false;
      }
    }
    meta.coins -= coins;
    meta.reputation -= reputation;
    if (materials) {
      for (const [key, value] of Object.entries(materials)) meta.materials[key] -= value;
    }
    this.save();
    return true;
  }

  // ---------------- 局外成长：等级 / 属性 / 天赋 / 机甲 ----------------
  /** 当前等级与经验进度 */
  getProgress() {
    const p = this.data.progress;
    return {
      level: p.level,
      xp: p.xp,
      points: p.points,
      next: xpToNext(p.level),
      max: p.level >= LEVEL.max,
    };
  }

  /**
   * 增加经验并处理连续升级；返回升级获得的属性点与新等级。
   * 满级后经验不再累计。
   */
  addXp(amount) {
    const p = this.data.progress;
    let gained = 0;
    if (p.level < LEVEL.max) {
      p.xp += Math.max(0, Math.floor(amount));
      while (p.level < LEVEL.max && p.xp >= xpToNext(p.level)) {
        p.xp -= xpToNext(p.level);
        p.level += 1;
        p.points += LEVEL.pointsPerLevel;
        gained += LEVEL.pointsPerLevel;
      }
      if (p.level >= LEVEL.max) p.xp = 0;
      this.save();
    }
    return { level: p.level, points: gained, xp: p.xp };
  }

  /** 分配一点属性；点数不足时返回 false（无上限，可无限加点） */
  allocateAttr(stat) {
    const def = ATTRIBUTES[stat];
    const p = this.data.progress;
    const cur = this.data.permanent[stat] || 0;
    if (!def || p.points <= 0) return false;
    this.data.permanent[stat] = cur + 1;
    p.points -= 1;
    this.save();
    return true;
  }

  /** 升级天赋；返回 {ok, message} */
  upgradeTalent(branch) {
    const def = this.data.talents;
    if (!(branch in def)) return { ok: false, message: '未知天赋分支' };
    const cost = talentCost(branch, def[branch]);
    if (!cost) return { ok: false, message: '该分支已满级' };
    if (!this.spend({ coins: cost.coins, materials: { awaken: cost.awaken } })) {
      return { ok: false, message: `需要 ${cost.coins} 金币 + ${cost.awaken} 觉醒材料` };
    }
    def[branch] += 1;
    this.save();
    return { ok: true, message: `天赋提升：${branch} → ${def[branch]} 级` };
  }

  /** 解锁机甲；返回 {ok, message} */
  unlockMech(id) {
    const def = MECHS[id];
    if (!def) return { ok: false, message: '未知机甲' };
    const mechs = this.data.unlocks.mechs || [];
    if (mechs.includes(id)) return { ok: false, message: '已解锁' };
    const gate = MECH_GATES[id];
    if (gate && !this.hasFeature('mech_' + id)) {
      if (!this.meets(gate)) return { ok: false, message: `需要 ${this.requirementText(gate)}` };
      // 声望作为一次性解锁消耗
      if (!this.spend({ reputation: gate.reputation || 0 })) {
        return { ok: false, message: `需要 ${gate.reputation} 声望` };
      }
      this.grantFeature('mech_' + id);
    }
    const cost = def.cost;
    if (!this.spend({ coins: cost.coins, materials: { mecha: cost.mecha } })) {
      return { ok: false, message: `需要 ${cost.coins} 金币 + ${cost.mecha} 机甲材料` };
    }
    mechs.push(id);
    this.save();
    return { ok: true, message: `已解锁：${def.name}` };
  }

  // ---------------- 材料 / 备弹 / 兑换 / 解锁 / 科研 ----------------
  /** 门槛检查：声望 / 等级 / 局外属性点 */
  meets(req = {}) {
    const meta = this.data.meta;
    if (req.reputation != null && (meta.reputation || 0) < req.reputation) return false;
    if (req.level != null && this.data.progress.level < req.level) return false;
    if (req.attr) {
      for (const [key, value] of Object.entries(req.attr)) {
        if ((this.data.permanent[key] || 0) < value) return false;
      }
    }
    return true;
  }

  hasFeature(id) {
    return (this.data.unlocks.features || []).includes(id);
  }

  /** 达成门槛后永久记录权限（声望被扣也不会倒退） */
  grantFeature(id) {
    if (this.hasFeature(id)) return;
    this.data.unlocks.features.push(id);
    this.save();
  }

  /** 门槛文本（用于 UI 与失败提示） */
  requirementText(req = {}) {
    const parts = [];
    if (req.reputation != null) parts.push(`声望 ${req.reputation}`);
    if (req.level != null) parts.push(`Lv.${req.level}`);
    if (req.attr) {
      for (const [key, value] of Object.entries(req.attr)) {
        parts.push(`${ATTRIBUTES[key]?.name || key} ${value} 点`);
      }
    }
    return parts.length ? parts.join(' · ') : '无门槛';
  }

  materialName(id) {
    return MATERIALS[id]?.name || id;
  }

  materialCount(id) {
    return this.data.meta.materials[id] || 0;
  }

  /** 发放材料（掉落 / 任务） */
  addMaterial(id, amount = 1) {
    if (!(id in this.data.meta.materials)) return false;
    this.data.meta.materials[id] += Math.max(0, amount);
    this.save();
    return true;
  }

  /** 材料当前售价（按累计购买次数递增） */
  materialShopPrice(id) {
    const def = MATERIAL_SHOP[id];
    if (!def) return 0;
    const key = def.material || id;
    return materialPrice(def, this.data.meta.shopBuys[key] || 0);
  }

  /** 商店档位是否已解锁（一次性权限，达成后永久保留） */
  materialUnlocked(id) {
    const def = MATERIAL_SHOP[id];
    if (!def) return false;
    return this.hasFeature('shop_' + id) || this.meets(def.unlock);
  }

  /** 购买一份材料：金币够、门槛达标才成交 */
  buyMaterial(id) {
    const def = MATERIAL_SHOP[id];
    if (!def) return { ok: false, message: '未知商品' };
    if (!this.hasFeature('shop_' + id)) {
      if (!this.meets(def.unlock)) {
        return { ok: false, message: `购买权限需要 ${this.requirementText(def.unlock)}` };
      }
      if (!this.spend({ reputation: def.unlock.reputation || 0 })) {
        return { ok: false, message: `解锁该档位需要 ${def.unlock.reputation} 声望` };
      }
      this.grantFeature('shop_' + id);
    }
    const key = def.material || id;
    const price = this.materialShopPrice(id);
    if ((this.data.meta.coins || 0) < price) {
      return { ok: false, message: `金币不足（需要 ${price}）` };
    }
    this.data.meta.coins -= price;
    this.data.meta.shopBuys[key] = (this.data.meta.shopBuys[key] || 0) + 1;
    this.data.meta.materials[key] = (this.data.meta.materials[key] || 0) + 1;
    this.save();
    return { ok: true, message: `购入 ${def.name}（${price} 金币）`, price };
  }

  /** 购买一格备弹（按口径），库存上限内 */
  buyAmmo(weaponId) {
    const def = AMMO_SHOP[weaponId];
    if (!def) return { ok: false, message: '未知弹种' };
    const stock = this.data.meta.ammoStock[weaponId] || 0;
    if (stock >= def.cap) return { ok: false, message: `${def.name}库存已满` };
    if ((this.data.meta.coins || 0) < def.price) {
      return { ok: false, message: `金币不足（需要 ${def.price}）` };
    }
    this.data.meta.coins -= def.price;
    this.data.meta.ammoStock[weaponId] = Math.min(def.cap, stock + def.rounds);
    this.save();
    return { ok: true, message: `补充 ${def.name} +${def.rounds}`, price: def.price };
  }

  exchangeUnlocked() {
    return this.hasFeature('exchange') || this.meets(EXCHANGE_UNLOCK);
  }

  /** 货币兑换（双向差价） */
  exchange(opId) {
    const op = EXCHANGE_OPS.find((o) => o.id === opId);
    if (!op) return { ok: false, message: '未知兑换' };
    if (!this.exchangeUnlocked()) {
      return { ok: false, message: `兑换功能需要 ${this.requirementText(EXCHANGE_UNLOCK)}` };
    }
    if (!this.hasFeature('exchange')) {
      if (!this.spend({ reputation: EXCHANGE_UNLOCK.reputation || 0 })) {
        return { ok: false, message: `解锁兑换功能需要 ${EXCHANGE_UNLOCK.reputation} 声望` };
      }
      this.grantFeature('exchange');
    }
    const meta = this.data.meta;
    const names = { coins: '金币', reputation: '声望', cores: '核心' };
    if ((meta[op.from] || 0) < op.fromAmount) {
      return { ok: false, message: `${names[op.from] || op.from} 不足（需要 ${op.fromAmount}）` };
    }
    meta[op.from] -= op.fromAmount;
    meta[op.to] = (meta[op.to] || 0) + op.toAmount;
    this.save();
    return { ok: true, message: `${op.label} 完成` };
  }

  // ---------------- 枪械改装解锁 ----------------
  isModSlotUnlocked(slotId) {
    return (this.data.unlocks.modSlots || []).includes(slotId);
  }

  unlockModSlot(slotId) {
    const price = MOD_UNLOCK.slots[slotId];
    if (price == null) return { ok: false, message: '未知槽位' };
    if (this.isModSlotUnlocked(slotId)) return { ok: false, message: '槽位已解锁' };
    if (!this.spend({ coins: price })) {
      return { ok: false, message: `需要 ${price} 金币解锁槽位` };
    }
    this.data.unlocks.modSlots.push(slotId);
    this.save();
    return { ok: true, message: '槽位已解锁' };
  }

  isAttachmentCrafted(attachmentId) {
    if (attachmentId === 'none') return true;
    return (this.data.unlocks.attachments || []).includes(attachmentId);
  }

  /** 制造配件：普通配件花金币；元素配件额外声望 + 首领核心 */
  craftAttachment(slotId, attachmentId) {
    const att = (ATTACHMENTS[slotId] || []).find((a) => a.id === attachmentId);
    if (!att || att.id === 'none') return { ok: false, message: '无需制造' };
    if (!this.isModSlotUnlocked(slotId)) {
      return { ok: false, message: '请先解锁该槽位' };
    }
    if (this.isAttachmentCrafted(attachmentId)) {
      return { ok: false, message: '已拥有该配件' };
    }
    if (att.element) {
      const c = MOD_UNLOCK.elementCraft;
      const firstElement = !this.hasFeature('elementCraft');
      if (firstElement && (this.data.meta.reputation || 0) < c.reputation) {
        return { ok: false, message: `元素配件需要声望 ${c.reputation}` };
      }
      if (this.materialCount('bossCore') < c.bossCore) {
        return { ok: false, message: `需要首领核心 ${c.bossCore}` };
      }
      if (!this.spend({ coins: c.coins, reputation: firstElement ? c.reputation : 0, materials: { bossCore: c.bossCore } })) {
        return { ok: false, message: `需要 ${c.coins} 金币 + ${c.bossCore} 首领核心` };
      }
      if (firstElement) this.grantFeature('elementCraft');
    } else if (!this.spend({ coins: MOD_UNLOCK.craft })) {
      return { ok: false, message: `需要 ${MOD_UNLOCK.craft} 金币制造` };
    }
    this.data.unlocks.attachments.push(attachmentId);
    this.save();
    return { ok: true, message: `已制造：${att.name}` };
  }

  // ---------------- 科研所 ----------------
  researchLevel(id) {
    return this.data.research[id] || 0;
  }

  /** 科研所是否已开放（一次性权限，声望被扣后不倒退） */
  researchUnlocked() {
    return this.hasFeature('researchLab') || this.meets(RESEARCH_UNLOCK);
  }

  /** 研究线是否已解锁（等级 > 0 或已记录权限） */
  researchLineUnlocked(id) {
    const def = RESEARCH[id];
    if (!def) return false;
    return this.data.research[id] > 0 || this.hasFeature('research_' + id) || this.meets(def.unlock);
  }

  /** 升级一条研究线；返回 {ok, message}（无上限，超出 5 级后成本持续递增） */
  upgradeResearch(id) {
    const def = RESEARCH[id];
    if (!def) return { ok: false, message: '未知研究线' };
    if (!this.researchUnlocked()) {
      return { ok: false, message: `科研所需要 ${this.requirementText(RESEARCH_UNLOCK)}` };
    }
    this.grantFeature('researchLab');
    const cur = this.researchLevel(id);
    const firstLine = cur === 0 && !this.hasFeature('research_' + id);
    if (firstLine && !this.meets(def.unlock)) {
      return { ok: false, message: `研究线解锁需要 ${this.requirementText(def.unlock)}` };
    }
    let cost;
    if (cur < def.levels.length) {
      cost = def.levels[cur];
    } else {
      // 超过配置的 5 级：按第 5 级成本递推，每级额外 +step
      const last = def.levels[def.levels.length - 1];
      const over = cur - def.levels.length + 1;
      const step = def.step || { coins: 400, material: 3, bossCore: 1 };
      cost = {
        coins: last.coins + step.coins * over,
        material: last.material + step.material * over,
        ...(last.bossCore ? { bossCore: last.bossCore + (step.bossCore || 1) * over } : null),
        ...(last.map ? { map: last.map } : null),
      };
    }
    const mat = def.material;
    const needMat = cost.material || 0;
    const repCost = firstLine ? (def.unlock.reputation || 0) : 0;
    if (this.materialCount(mat) < needMat) {
      return { ok: false, message: `需要 ${MATERIALS[mat]?.name || mat} ${needMat}` };
    }
    if (cost.bossCore && this.materialCount('bossCore') < cost.bossCore) {
      return { ok: false, message: `需要首领核心 ${cost.bossCore}` };
    }
    if (cost.map && this.materialCount(cost.map) < 1) {
      return { ok: false, message: `需要 ${MATERIALS[cost.map]?.name || cost.map} 1` };
    }
    const materials = { [mat]: needMat };
    if (cost.bossCore) materials.bossCore = cost.bossCore;
    if (cost.map) materials[cost.map] = 1;
    if (!this.spend({ coins: cost.coins, reputation: repCost, materials })) {
      return { ok: false, message: `需要 ${cost.coins} 金币${repCost ? ` + ${repCost} 声望` : ''}` };
    }
    this.data.research[id] = cur + 1;
    if (firstLine) this.grantFeature('research_' + id);
    this.save();
    return { ok: true, message: `${def.name} → ${cur + 1} 级` };
  }

  /** 汇总科研加成 */
  researchTotals() {
    return researchTotals(this.data);
  }

  /** 机甲是否已解锁 */
  hasMech(id) {
    return (this.data.unlocks.mechs || []).includes(id);
  }

  /** 任务列表：进度按累计战绩实时计算 */
  getMissionStates() {
    const claimed = this.data.meta.claimedMissions || [];
    return MISSIONS.map((m) => ({
      id: m.id,
      name: m.name,
      desc: m.desc,
      target: m.target,
      progress: missionProgress(m, this.data.stats),
      claimed: claimed.includes(m.id),
      reward: m.reward,
    }));
  }

  /** 领取任务奖励；未完成 / 已领取返回 null */
  claimMission(id) {
    const def = MISSIONS.find((m) => m.id === id);
    if (!def) return null;
    if (this.data.meta.claimedMissions.includes(id)) return null;
    if (missionProgress(def, this.data.stats) < def.target) return null;
    const granted = this._grantReward(def.reward);
    this.data.meta.claimedMissions.push(id);
    this.save();
    return granted;
  }

  /**
   * 一局结束后调用：累计战绩 + 结算金币 / 声望 / 核心
   * @param {{kills?:number, seconds?:number, level?:number, wave?:number, win?:boolean}} run
   * @returns {{coins:number, reputation:number, cores:number, materials:object}}
   */
  recordRun({ kills = 0, seconds = 0, level = null, wave = null, win = false } = {}) {
    const st = this.data.stats;
    st.runs += 1;
    st.kills += kills;
    st.totalTime += seconds;
    if (level != null) st.bestLevel = Math.max(st.bestLevel, level);
    if (wave != null) st.bestWave = Math.max(st.bestWave, wave);
    if (win && level != null) {
      this.data.unlocks.levels = Math.max(this.data.unlocks.levels, level + 1);
    }
    const rewards = calcRunRewards({ kills, waves: wave || 0, win });
    // 收益研究：结算金币加成
    const rt = this.researchTotals();
    rewards.coins = Math.round(rewards.coins * rt.coinMul);
    this._grantReward(rewards);
    const xp = Math.round(runXp({ kills, waves: wave || 0, win }) * rt.xpMul);
    const up = this.addXp(xp);
    rewards.xp = xp;
    rewards.levelUp = up.points > 0 ? up.points : 0;
    rewards.level = up.level;
    this.save();
    return rewards;
  }
}
