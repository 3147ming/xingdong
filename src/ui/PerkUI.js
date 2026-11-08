/**
 * 波间三选一 Perk 界面：
 *  - 屏幕中央弹出三张卡片（攻击 / 生存 / 特殊），点击即生效
 *  - 屏幕右侧常驻已选 perk 小图标（带层数）
 * 样式统一放在 styles/hud.css，不新建 css 文件。
 */
import { PERK_CATEGORY_LABEL } from '../config/perks.js';

export class PerkUI {
  constructor({ onPick, onSkip } = {}) {
    this.onPick = onPick || (() => {});
    this.onSkip = onSkip || (() => {});
    this._build();
  }

  _build() {
    const overlay = document.createElement('div');
    overlay.id = 'perk-overlay';
    overlay.className = 'perk-overlay hidden';
    overlay.innerHTML = `
      <div class="perk-head">
        <div class="perk-title">选择一项强化</div>
        <div class="perk-sub">波次奖励 · 本局永久生效 · 可重复叠加</div>
      </div>
      <div class="perk-cards"></div>
      <button class="perk-skip" id="perk-skip">跳过本次强化</button>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.cardsBox = overlay.querySelector('.perk-cards');
    overlay.querySelector('#perk-skip').addEventListener('click', () => this.onSkip());

    const badges = document.createElement('div');
    badges.id = 'perk-badges';
    badges.className = 'perk-badges';
    document.body.appendChild(badges);
    this.badges = badges;
  }

  /** 展示三选一；defs 为 perk 定义数组 */
  show(defs, perkSystem) {
    this.cardsBox.innerHTML = '';
    for (const def of defs) {
      const owned = perkSystem ? perkSystem.countOf(def.id) : 0;
      const card = document.createElement('button');
      card.className = `perk-card cat-${def.cat}`;
      card.dataset.perk = def.id;
      card.innerHTML = `
        <span class="perk-icon">${def.icon}</span>
        <span class="perk-name">${def.name}</span>
        <span class="perk-desc">${def.desc}</span>
        <span class="perk-meta">${PERK_CATEGORY_LABEL[def.cat] || ''}${owned > 0 ? ` · 已选 ${owned} 层` : ''}</span>
      `;
      card.addEventListener('click', () => this.onPick(def.id));
      this.cardsBox.appendChild(card);
    }
    this.overlay.classList.remove('hidden');
  }

  hide() {
    this.overlay.classList.add('hidden');
  }

  get visible() {
    return !this.overlay.classList.contains('hidden');
  }

  /** 右侧图标栏：已选 perk + 层数 */
  renderBadges(perkSystem) {
    const chosen = perkSystem ? perkSystem.chosen : [];
    this.badges.innerHTML = chosen.map(({ def, stacks }) => `
      <div class="perk-badge cat-${def.cat}" title="${def.name}：${def.desc}">
        <i>${def.icon}</i>${stacks > 1 ? `<b>${stacks}</b>` : ''}
      </div>
    `).join('');
    this.badges.classList.toggle('hidden', chosen.length === 0);
  }

  /** 清空图标（新局 / 返回大厅） */
  reset() {
    this.hide();
    this.badges.innerHTML = '';
    this.badges.classList.add('hidden');
  }
}
