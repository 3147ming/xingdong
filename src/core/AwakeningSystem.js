/**
 * 觉醒模式运行时：路线计数、觉醒 perk 累积、形态解锁检测。
 *
 * 和 PerkSystem 类似，但：
 *   - 按 route 分组；
 *   - 有形态等级（0/1/2/3），由 FORM_THRESHOLDS 触发；
 *   - mods = PERK_MODS + FORM_BONUS + AWAKEN_PERKS（三者合并后返回给 Game）。
 */
import { AWAKEN_DEFS, AWAKEN_ROUTES, FORM_THRESHOLDS, formBonus } from '../config/awakening.js';

export class AwakeningSystem {
  constructor() {
    this.stacks = new Map();           // awakenId -> 层数
    this.routeCounts = { fury: 0, warden: 0, arcane: 0 };  // 每路线累计觉醒次数
    this._formLevel = { fury: 0, warden: 0, arcane: 0 };   // 已解锁的形态等级
  }

  reset() {
    this.stacks.clear();
    this.routeCounts = { fury: 0, warden: 0, arcane: 0 };
    this._formLevel = { fury: 0, warden: 0, arcane: 0 };
  }

  /** 某路线当前形态等级（0-3） */
  formLevel(route) {
    return this._formLevel[route] || 0;
  }

  /** 当前最高形态路线（用于 HUD 边框颜色） */
  get primaryRoute() {
    let best = null;
    for (const r of Object.keys(this.routeCounts)) {
      if (!best || this.routeCounts[r] > this.routeCounts[best]) best = r;
    }
    return best;
  }

  /** 某路线累计觉醒次数 */
  countOfRoute(route) {
    return this.routeCounts[route] || 0;
  }

  countOf(id) {
    return this.stacks.get(id) || 0;
  }

  /** 已选觉醒 perk 列表 */
  get chosen() {
    const out = [];
    for (const [id, n] of this.stacks) {
      const def = AWAKEN_DEFS.find((p) => p.id === id);
      if (def) out.push({ def, stacks: n });
    }
    return out;
  }

  /** 已解锁形态列表 [{route, level}] */
  get forms() {
    const out = [];
    for (const r of Object.keys(this._formLevel)) {
      const lvl = this._formLevel[r];
      if (lvl > 0) out.push({ route: r, level: lvl });
    }
    return out;
  }

  /**
   * 随机抽取 count 个觉醒 perk。
   * 按当前各路线觉醒数加权倾斜：路线越"主流"，该路线 perk 出现概率越低（平衡 build 选择）。
   */
  roll(count = 3, rng = Math.random) {
    // 计算权重：主流路线权重降低，鼓励分支探索
    const total = Object.values(this.routeCounts).reduce((a, b) => a + b, 0) || 1;
    const weights = {};
    for (const r of Object.keys(this.routeCounts)) {
      const p = this.routeCounts[r] / total;
      weights[r] = 0.35 + (1 - p) * 0.65;  // 最低 0.35，最高 1.0
    }

    const weighted = [];
    for (const def of AWAKEN_DEFS) {
      const w = weights[def.route] || 0.5;
      weighted.push({ def, w });
    }

    // Weighted reservoir 采样
    const picked = [];
    const usedIds = new Set();
    while (picked.length < count && weighted.length > 0) {
      // 归一化权重后随机选
      const totalW = weighted.reduce((a, e) => a + e.w, 0);
      let r = rng() * totalW;
      let idx = 0;
      for (; idx < weighted.length; idx++) {
        r -= weighted[idx].w;
        if (r <= 0) break;
      }
      const entry = weighted.splice(Math.min(idx, weighted.length - 1), 1)[0];
      if (!usedIds.has(entry.def.id)) {
        picked.push(entry.def);
        usedIds.add(entry.def.id);
      }
    }
    return picked;
  }

  /**
   * 选择一项觉醒 perk。
   * @returns {{def, newForms: Array<{route, level}>}} def = 选中定义；newForms = 本次新解锁的形态（可能为空）
   */
  pick(id) {
    const def = AWAKEN_DEFS.find((p) => p.id === id);
    if (!def) return null;
    const n = this.countOf(id);
    this.stacks.set(id, n + 1);
    this.routeCounts[def.route] += 1;

    // 检测形态解锁
    const newForms = [];
    const level = this.routeCounts[def.route];
    for (const threshold of FORM_THRESHOLDS) {
      if (level >= threshold && this._formLevel[def.route] < threshold / 2) {
        // FORM_THRESHOLDS 是 [2,4,6]，对应 level 1/2/3
        const formLvl = threshold / 2;
        if (this._formLevel[def.route] < formLvl) {
          this._formLevel[def.route] = formLvl;
          newForms.push({ route: def.route, level: formLvl });
        }
      }
    }

    return { def, newForms };
  }

  /**
   * 汇总所有觉醒增益（觉醒 perk + 形态 bonus）。
   * 返回 plain object，Game 合并到 total mods 中。
   */
  buildMods() {
    const m = {};
    // 形态 bonus 先叠（基础）
    for (const r of Object.keys(this._formLevel)) {
      const lvl = this._formLevel[r];
      if (lvl > 0) {
        const fb = formBonus(r, lvl);
        for (const k of Object.keys(fb)) m[k] = (m[k] || 0) + fb[k];
      }
    }
    // 觉醒 perk 再叠
    for (const [id, n] of this.stacks) {
      const def = AWAKEN_DEFS.find((p) => p.id === id);
      if (!def) continue;
      // 每层叠加一次（允许重复选同一觉醒 perk 放大效果）
      for (let i = 0; i < n; i++) def.apply(m);
    }
    return m;
  }
}
