/**
 * 觉醒模式专属面板：每 3 波弹出，视觉比 perk 更震撼（大标题 + 路线进度 + 形态展示）。
 *   - 顶部显示三路线进度条
 *   - 中央 3 张觉醒卡片（带路线颜色边框）
 *   - 底部显示当前最高形态徽章
 */
import { AWAKEN_ROUTES, FORM_THRESHOLDS } from '../config/awakening.js';

export class AwakenUI {
  constructor({ onPick, onSkip } = {}) {
    this.onPick = onPick || (() => {});
    this.onSkip = onSkip || (() => {});
    this._build();
  }

  _build() {
    const overlay = document.createElement('div');
    overlay.id = 'awaken-overlay';
    overlay.className = 'awaken-overlay hidden';
    overlay.innerHTML = `
      <div class="awaken-bg"></div>
      <div class="awaken-wrap">
        <div class="awaken-head">
          <div class="awaken-eyebrow">≡ AWAKENING ≡</div>
          <div class="awaken-title">灵魂觉醒</div>
          <div class="awaken-sub">选择一条觉醒之路 · 累积触发形态解锁</div>
        </div>
        <div class="awaken-routes" id="awaken-routes"></div>
        <div class="awaken-cards" id="awaken-cards"></div>
        <button class="awaken-skip" id="awaken-skip">暂不觉醒</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.routesBox = overlay.querySelector('#awaken-routes');
    this.cardsBox = overlay.querySelector('#awaken-cards');
    overlay.querySelector('#awaken-skip').addEventListener('click', () => this.onSkip());

    // HUD 常驻的觉醒形态徽章
    const badge = document.createElement('div');
    badge.id = 'awaken-badge';
    badge.className = 'awaken-badge hidden';
    document.body.appendChild(badge);
    this.badge = badge;
  }

  /** 展示觉醒选项 */
  show(defs, awakenSystem) {
    this._renderRoutes(awakenSystem);
    this.cardsBox.innerHTML = '';
    for (const def of defs) {
      const route = AWAKEN_ROUTES[def.route];
      const owned = awakenSystem ? awakenSystem.countOf(def.id) : 0;
      const card = document.createElement('button');
      card.className = `awaken-card route-${def.route}`;
      card.style.setProperty('--route-color', route ? route.color : '#fff');
      card.dataset.awaken = def.id;
      card.innerHTML = `
        <span class="awaken-card-route">${route ? route.name : ''}</span>
        <span class="awaken-card-name">${def.name}</span>
        <span class="awaken-card-desc">${def.desc}</span>
        <span class="awaken-card-meta">${owned > 0 ? `已觉醒 ${owned} 次` : '初次觉醒'}</span>
      `;
      card.addEventListener('click', () => this.onPick(def.id));
      this.cardsBox.appendChild(card);
    }
    this.overlay.classList.remove('hidden');
    // 触发入场动画
    this.overlay.classList.remove('awaken-pop');
    void this.overlay.offsetWidth; // 强制 reflow 重启动画
    this.overlay.classList.add('awaken-pop');
  }

  hide() {
    this.overlay.classList.add('hidden');
  }

  get visible() {
    return !this.overlay.classList.contains('hidden');
  }

  _renderRoutes(sys) {
    const box = this.routesBox;
    box.innerHTML = '';
    for (const r of Object.keys(AWAKEN_ROUTES)) {
      const route = AWAKEN_ROUTES[r];
      const count = sys ? sys.countOfRoute(r) : 0;
      const lvl = sys ? sys.formLevel(r) : 0;
      const next = FORM_THRESHOLDS.find((t) => t > count) || FORM_THRESHOLDS[FORM_THRESHOLDS.length - 1] + 2;
      const pct = Math.min(100, (count / next) * 100);
      const formStars = lvl > 0 ? '★'.repeat(lvl) : '';
      const el = document.createElement('div');
      el.className = `awaken-route awaken-route-${r}`;
      el.style.setProperty('--route-color', route.color);
      el.innerHTML = `
        <div class="ar-name">${route.name}</div>
        <div class="ar-bar"><div class="ar-fill" style="width:${pct}%"></div></div>
        <div class="ar-meta">${count}/${next} 次 ${formStars ? `<span class="ar-form">${formStars}</span>` : ''}</div>
      `;
      box.appendChild(el);
    }
  }

  /** 刷新 HUD 常驻形态徽章 */
  renderBadges(sys) {
    const forms = sys ? sys.forms : [];
    if (!forms.length) {
      this.badge.classList.add('hidden');
      return;
    }
    const primary = sys.primaryRoute;
    const route = AWAKEN_ROUTES[primary];
    const primaryLvl = sys.formLevel(primary);
    this.badge.innerHTML = `
      <i class="ab-icon" style="color:${route ? route.color : '#fff'}">◈</i>
      <span class="ab-text">${route ? route.name : ''}</span>
      <span class="ab-form">Lv.${primaryLvl}</span>
    `;
    this.badge.classList.remove('hidden');
    this.badge.style.setProperty('--route-color', route ? route.color : '#fff');
  }

  /** 重置（新局 / 返回大厅） */
  reset() {
    this.hide();
    this.badge.classList.add('hidden');
    this.badge.innerHTML = '';
  }
}
