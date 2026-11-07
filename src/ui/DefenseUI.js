/**
 * 守城 HUD / 波间商店界面。
 * 只负责 DOM 展示与按钮回调，游戏逻辑由 DefenseManager / Game 处理。
 */
export class DefenseUI {
  constructor({ onBuy, onContinue } = {}) {
    this.onBuy = onBuy || (() => {});
    this.onContinue = onContinue || (() => {});
    this.weaponVisible = false;
    this._buildStatus();
    this._buildShop();
  }

  _buildStatus() {
    const host = document.getElementById('hud') || document.body;

    this.statusEl = document.createElement('div');
    this.statusEl.id = 'defense-status';
    this.statusEl.className = 'defense-status hidden';
    this.statusEl.innerHTML = [
      '<div class="core-row"><span>领地核心</span><b id="core-value">0</b></div>',
      '<div class="bar core"><i id="core-fill"></i></div>',
      '<div class="gold-row"><i class="res-dot coin"></i>局内金币 <b id="defense-gold">0</b></div>',
    ].join('');
    host.appendChild(this.statusEl);
    this.coreValue = this.statusEl.querySelector('#core-value');
    this.coreFill = this.statusEl.querySelector('#core-fill');
    this.goldValue = this.statusEl.querySelector('#defense-gold');

    this.interactEl = document.createElement('div');
    this.interactEl.id = 'interact-tip';
    this.interactEl.className = 'interact-tip hidden';
    this.interactEl.innerHTML = '<b>F</b><span></span>';
    host.appendChild(this.interactEl);
    this.interactText = this.interactEl.querySelector('span');

    this.weaponEl = document.createElement('div');
    this.weaponEl.id = 'special-panel';
    this.weaponEl.className = 'special-panel hidden';
    this.weaponEl.innerHTML = [
      '<div class="special-name" id="special-name">场景武器</div>',
      '<div class="special-ammo" id="special-ammo">0 / 0</div>',
      '<div class="special-heat"><i id="special-heat-fill"></i></div>',
      '<div class="special-hint" id="special-hint"></div>',
    ].join('');
    host.appendChild(this.weaponEl);
    this.weaponName = this.weaponEl.querySelector('#special-name');
    this.weaponAmmo = this.weaponEl.querySelector('#special-ammo');
    this.weaponHeat = this.weaponEl.querySelector('#special-heat-fill');
    this.weaponHint = this.weaponEl.querySelector('#special-hint');

    // 闯关 / 无尽的局内金币（守城模式用上面的 statusEl，不重复显示）
    this.runGoldEl = document.createElement('div');
    this.runGoldEl.id = 'run-gold';
    this.runGoldEl.className = 'run-gold hidden';
    this.runGoldEl.innerHTML = '<i class="res-dot coin"></i>局内金币 <b id="run-gold-value">0</b>';
    host.appendChild(this.runGoldEl);
    this.runGoldValue = this.runGoldEl.querySelector('#run-gold-value');
  }

  /** 更新局内战地金币 */
  setRunGold(n) {
    if (this.runGoldValue) this.runGoldValue.textContent = String(Math.round(n));
  }

  /** 显示 / 隐藏局内金币条（守城模式隐藏，用核心面板里的金币行） */
  setRunGoldVisible(on) {
    if (this.runGoldEl) this.runGoldEl.classList.toggle('hidden', !on);
  }

  _buildShop() {
    this.shopEl = document.createElement('div');
    this.shopEl.id = 'shop-panel';
    this.shopEl.className = 'overlay hidden';
    this.shopEl.innerHTML = [
      '<div class="panel shop-panel">',
      '  <p class="result-kicker">WAVE CLEARED</p>',
      '  <h2>波间军需</h2>',
      '  <p class="shop-sub" id="shop-sub">布置火力网后再迎接下一波</p>',
      '  <div class="shop-gold">局内金币 <b id="shop-gold">0</b></div>',
      '  <div class="shop-grid" id="shop-grid"></div>',
      '  <p class="shop-feedback" id="shop-feedback"></p>',
      '  <button class="btn primary" id="btn-shop-continue">继续下一波</button>',
      '</div>',
    ].join('');
    document.body.appendChild(this.shopEl);
    this.shopSub = this.shopEl.querySelector('#shop-sub');
    this.shopTitle = this.shopEl.querySelector('h2');
    this.shopKicker = this.shopEl.querySelector('.result-kicker');
    this.shopGold = this.shopEl.querySelector('#shop-gold');
    this.shopGrid = this.shopEl.querySelector('#shop-grid');
    this.shopFeedback = this.shopEl.querySelector('#shop-feedback');
    this.shopContinue = this.shopEl.querySelector('#btn-shop-continue');
    this.shopGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy]');
      if (!btn || btn.disabled) return;
      this.onBuy(btn.dataset.buy);
    });
    this.shopEl.querySelector('#btn-shop-continue').addEventListener('click', () => this.onContinue());
  }

  setActive(on) {
    this.statusEl.classList.toggle('hidden', !on);
    if (!on) {
      this.interactEl.classList.add('hidden');
      this.weaponEl.classList.add('hidden');
      this.shopEl.classList.add('hidden');
      this.weaponVisible = false;
    }
  }

  setCore(hp, max) {
    const k = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
    this.coreFill.style.width = `${(k * 100).toFixed(1)}%`;
    this.coreValue.textContent = String(Math.round(hp));
    this.statusEl.classList.toggle('danger', k <= 0.3);
  }

  setGold(n) {
    this.goldValue.textContent = String(Math.round(n));
    if (!this.shopEl.classList.contains('hidden')) this.shopGold.textContent = String(Math.round(n));
  }

  setInteract(text) {
    if (!text) {
      this.interactEl.classList.add('hidden');
      return;
    }
    this.interactText.textContent = text;
    this.interactEl.classList.remove('hidden');
  }

  setWeapon(info) {
    if (!info) {
      this.weaponEl.classList.add('hidden');
      this.weaponVisible = false;
      return;
    }
    this.weaponVisible = true;
    this.weaponEl.classList.remove('hidden');
    this.weaponName.textContent = info.name;
    this.weaponAmmo.textContent = info.ammoMax
      ? `${Math.max(0, Math.round(info.ammo))} / ${info.ammoMax}`
      : String(Math.max(0, Math.round(info.ammo)));
    const heat = info.heatMax ? Math.min(1, info.heat / info.heatMax) : 0;
    this.weaponHeat.style.width = `${(heat * 100).toFixed(0)}%`;
    this.weaponEl.classList.toggle('overheat', !!info.overheated);
    this.weaponHint.textContent = info.overheated ? '过热冷却中，等待降温…' : info.hint;
  }

  showShop(state, wave, buyLabel = '部署') {
    this.buyLabel = buyLabel;
    if (this.shopTitle) this.shopTitle.textContent = '波间军需';
    if (this.shopKicker) this.shopKicker.textContent = 'WAVE CLEARED';
    if (this.shopContinue) this.shopContinue.textContent = '继续下一波';
    this.shopSub.textContent = `第 ${wave} 波已肃清 · 布置火力网后再迎接下一波`;
    this.shopFeedback.textContent = '';
    this.updateShop(state);
    this.shopEl.classList.remove('hidden');
  }

  updateShop(state, feedback = '') {
    this.shopGold.textContent = String(Math.round(state.gold));
    this.shopFeedback.textContent = feedback;
    this._renderItems(state.items);
  }

  _renderItems(items) {
    this.shopGrid.innerHTML = items.map((it) => {
      const disabled = it.disabled || !it.affordable;
      return [
        `<div class="shop-card${disabled ? ' disabled' : ''}">`,
        `  <h3>${it.name}</h3>`,
        `  <p>${it.desc}</p>`,
        `  <div class="shop-card-foot">`,
        `    <span class="shop-cost">${it.costLabel}</span>`,
        `    <span class="shop-tip">${it.tip}</span>`,
        `  </div>`,
        `  <button class="btn mini shop-buy" data-buy="${it.id}"${disabled ? ' disabled' : ''}>${this.buyLabel || '部署'}</button>`,
        `</div>`,
      ].join('');
    }).join('');
  }

  hideShop() {
    this.shopEl.classList.add('hidden');
  }

  get shopVisible() {
    return !this.shopEl.classList.contains('hidden');
  }
}
