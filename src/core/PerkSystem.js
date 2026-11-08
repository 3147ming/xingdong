/**
 * Roguelike Perk 运行时：随机三选一、层数记录、增益汇总。
 * 每次选择后重建增益对象，Game 通过 mods 一次性应用到武器 / 玩家。
 */
import { PERK_DEFS, emptyPerkMods, SLOWMO_CAP } from '../config/perks.js';

export class PerkSystem {
  constructor() {
    this.stacks = new Map();     // perkId -> 层数
    this._mods = emptyPerkMods();
  }

  /** 开局 / 重开：清空全部 perk */
  reset() {
    this.stacks.clear();
    this._mods = emptyPerkMods();
  }

  /** 已选层数 */
  countOf(id) {
    return this.stacks.get(id) || 0;
  }

  get maxed() {
    return this.stacks.size >= PERK_DEFS.length;
  }

  /** 汇总后的增益对象 */
  get mods() {
    return this._mods;
  }

  /** 实际生效的时间减缓比例（带安全上限） */
  get slowMo() {
    return Math.min(SLOWMO_CAP, this._mods.slowMoAdd);
  }

  /** 已选列表（用于侧边栏图标） */
  get chosen() {
    const out = [];
    for (const [id, n] of this.stacks) {
      const def = PERK_DEFS.find((p) => p.id === id);
      if (def) out.push({ def, stacks: n });
    }
    return out;
  }

  /** 随机抽取 count 个不重复、且未达到层数上限的 perk */
  roll(count = 3, rng = Math.random) {
    const pool = PERK_DEFS.filter((p) => this.countOf(p.id) < (p.max ?? Infinity));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, Math.min(count, pool.length));
  }

  /** 选择一项 perk，返回该定义（已满层则返回 null） */
  pick(id) {
    const def = PERK_DEFS.find((p) => p.id === id);
    if (!def) return null;
    const n = this.countOf(id);
    if (n >= (def.max ?? Infinity)) return null;
    this.stacks.set(id, n + 1);
    this._rebuild();
    return def;
  }

  /** 按当前层数重新计算增益 */
  _rebuild() {
    const m = emptyPerkMods();
    for (const [id, n] of this.stacks) {
      const def = PERK_DEFS.find((p) => p.id === id);
      if (def) def.apply(m, n);
    }
    this._mods = m;
  }
}
