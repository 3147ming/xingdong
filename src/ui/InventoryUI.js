/**
 * 行囊系统（B 打开）：网格化物品栏，支持使用 / 丢弃。
 *
 * 物品来源：野外补给"满员溢出"——例如满血时捡到的医疗包会自动存入行囊，
 * 需要时再打开行囊使用。这样补给点不再因为状态满而被浪费。
 */

const ITEM_DEFS = {
  medkit: { name: '急救包', icon: '✚', color: '#5ec97a', desc: '回复 50 点生命', max: 9 },
  armor: { name: '护甲板', icon: '▣', color: '#5aa0e0', desc: '回复 25 点护甲', max: 9 },
  ammo: { name: '弹药箱', icon: '▤', color: '#e0b04a', desc: '补充当前武器备弹 30 发', max: 9 },
  throwable: { name: '投掷包', icon: '◈', color: '#d07a45', desc: '补充 2 枚投掷物', max: 9 },
};

const SLOT_COUNT = 12;   // 展示格数（固定网格，空格占位）

export class InventoryUI {
  /**
   * @param opts { onUse(type) => boolean, onDrop(type) => void, onClose() => void }
   */
  constructor(opts = {}) {
    this.onUse = opts.onUse || (() => false);
    this.onDrop = opts.onDrop || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.items = { medkit: 0, armor: 0, ammo: 0, throwable: 0 };
    this._build();
    this.refresh();
  }

  _build() {
    const root = document.createElement('div');
    root.id = 'inventory';
    root.className = 'inventory hidden';
    root.innerHTML = `
      <div class="inv-panel">
        <div class="inv-head">
          <h3>行囊</h3>
          <span class="inv-sub">满员拾取的补给会自动存入这里</span>
          <button type="button" class="inv-close" id="inv-close" aria-label="关闭行囊">×</button>
        </div>
        <div class="inv-grid" id="inv-grid"></div>
        <div class="inv-foot"><b>B</b> / <b>Esc</b> 关闭 · 点击物品可使用或丢弃</div>
      </div>`;
    document.body.appendChild(root);

    this.root = root;
    this.grid = root.querySelector('#inv-grid');
    root.querySelector('#inv-close').addEventListener('click', () => this.close());

    // 事件委托：使用 / 丢弃
    this.grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const { act, type } = btn.dataset;
      if (act === 'use') this.use(type);
      else if (act === 'drop') this.drop(type);
    });
  }

  /** 存入物品（超过上限返回 false） */
  add(type, n = 1) {
    const def = ITEM_DEFS[type];
    if (!def) return false;
    const cur = this.items[type] || 0;
    if (cur >= def.max) return false;
    this.items[type] = Math.min(def.max, cur + n);
    if (this.isOpen) this.refresh();
    return true;
  }

  count(type) {
    return this.items[type] || 0;
  }

  /** 使用一个物品；onUse 返回 true 才真正扣减 */
  use(type) {
    if ((this.items[type] || 0) <= 0) return false;
    if (!this.onUse(type)) return false;
    this.items[type] -= 1;
    this.refresh();
    return true;
  }

  /** 丢弃一个物品（局内行囊，丢弃即消失） */
  drop(type) {
    if ((this.items[type] || 0) <= 0) return;
    this.items[type] -= 1;
    this.onDrop(type);
    this.refresh();
  }

  reset() {
    for (const k of Object.keys(this.items)) this.items[k] = 0;
    if (this.isOpen) this.refresh();
  }

  refresh() {
    if (!this.grid) return;
    const entries = Object.entries(ITEM_DEFS).filter(([id]) => (this.items[id] || 0) > 0);
    const cells = [];
    for (const [id, def] of entries) {
      const n = this.items[id];
      cells.push(`
        <div class="inv-slot filled" style="--slot:${def.color}">
          <span class="inv-icon">${def.icon}</span>
          <span class="inv-count">×${n}</span>
          <b class="inv-name">${def.name}</b>
          <span class="inv-desc">${def.desc}</span>
          <div class="inv-actions">
            <button type="button" data-act="use" data-type="${id}">使用</button>
            <button type="button" data-act="drop" data-type="${id}" class="ghost">丢弃</button>
          </div>
        </div>`);
    }
    for (let i = cells.length; i < SLOT_COUNT; i++) cells.push('<div class="inv-slot"></div>');
    this.grid.innerHTML = cells.join('');
    if (entries.length === 0) {
      this.grid.innerHTML = `<div class="inv-empty">行囊空空如也<br><span>生命 / 护甲 / 备弹满员时拾取补给，会自动存入行囊</span></div>`;
    }
  }

  get isOpen() {
    return this.root && !this.root.classList.contains('hidden');
  }

  open() {
    if (!this.root) return;
    this.root.classList.remove('hidden');
    this.refresh();
  }

  close() {
    if (!this.root || !this.isOpen) return;
    this.root.classList.add('hidden');
    this.onClose();
  }
}

export { ITEM_DEFS };
