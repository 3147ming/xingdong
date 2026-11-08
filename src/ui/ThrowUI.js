/**
 * 投掷物 HUD：左下角常驻显示手雷 / 燃烧瓶数量，
 * 投掷态高亮当前道具，蓄力时显示蓄力条。
 * DOM 挂在 #hud 内，跟随战斗 HUD 一起隐藏。
 */
export class ThrowUI {
  constructor() {
    const hud = document.getElementById('hud') || document.body;
    const box = document.createElement('div');
    box.className = 'throw-hud';
    box.innerHTML = `
      <div class="throw-item" data-kind="frag">
        <b>G</b><span>手雷</span><i class="throw-count">×2</i>
      </div>
      <div class="throw-item" data-kind="molotov">
        <b>H</b><span>燃烧瓶</span><i class="throw-count">×2</i>
      </div>
      <div class="throw-item blueprint hidden" data-kind="blueprint">
        <b>F</b><span class="blueprint-name">蓝图</span><i>放置</i>
      </div>
      <div class="throw-charge"><i></i></div>
    `;
    hud.appendChild(box);
    this.box = box;
    this.items = {
      frag: box.querySelector('[data-kind="frag"]'),
      molotov: box.querySelector('[data-kind="molotov"]'),
    };
    this.blueprintItem = box.querySelector('[data-kind="blueprint"]');
    this.blueprintName = box.querySelector('.blueprint-name');
    this.chargeBar = box.querySelector('.throw-charge i');
  }

  /** 每帧同步数量 / 当前投掷态 / 蓄力进度 / 放置蓝图 */
  update(system, blueprintName = '') {
    if (!system) return;
    for (const kind of ['frag', 'molotov']) {
      const item = this.items[kind];
      if (!item) continue;
      item.classList.toggle('active', system.mode === kind);
      item.classList.toggle('empty', system.counts[kind] <= 0);
      const countEl = item.querySelector('.throw-count');
      if (countEl) countEl.textContent = `×${system.counts[kind]}`;
    }
    this.chargeBar.style.transform = `scaleX(${system.charging ? system.charge : 0})`;

    if (this.blueprintItem) {
      const has = !!blueprintName;
      this.blueprintItem.classList.toggle('hidden', !has);
      this.blueprintItem.classList.toggle('active', has);
      if (has) this.blueprintName.textContent = blueprintName;
    }
  }
}
