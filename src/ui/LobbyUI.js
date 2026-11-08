/**
 * 待机大厅面板（P0 骨架）
 * 只负责大厅内部的标签页切换与数值展示，不含游戏逻辑。
 * 后续 P3/P4/P5 会把机甲、天赋、商店的真实交互接到这里。
 */
import { ATTRIBUTES, MECHS, TALENTS, talentCost } from '../config/growth.js';
import { MECH_GATES } from '../config/progression.js';
export class LobbyUI {
  constructor() {
    this.root = document.getElementById('menu');
    this.nav = document.getElementById('lobby-nav');
    this.enterTestingBtn = document.getElementById('btn-enter-testing');
    this.pages = {
      battle: document.getElementById('tab-battle'),
      missions: document.getElementById('tab-missions'),
      exchange: document.getElementById('tab-exchange'),
      research: document.getElementById('tab-research'),
      armory: document.getElementById('tab-armory'),
      mech: document.getElementById('tab-mech'),
      talent: document.getElementById('tab-talent'),
      testing: document.getElementById('tab-testing'),
      settings: document.getElementById('tab-settings'),
    };

    this.cores = document.getElementById('lobby-cores');
    this.coins = document.getElementById('lobby-coins');
    this.reputation = document.getElementById('lobby-rep');

    this.activeTab = 'battle';
    this.mode = 'campaign';
    this.modeCards = Array.from(document.querySelectorAll('.mode-card[data-mode]'));
    this.startBtn = document.getElementById('btn-start');
    this.growth = null;
    this._bindNav();
    this._bindModes();
    if (this.enterTestingBtn) {
      this.enterTestingBtn.addEventListener('click', () => this.onEnterTesting?.());
    }
  }

  _bindModes() {
    for (const card of this.modeCards) {
      card.addEventListener('click', () => this.setMode(card.dataset.mode));
    }
  }

  /** 选择作战模式并同步卡片高亮 / 开始按钮文案 */
  setMode(id) {
    if (!id) return;
    this.mode = id;
    for (const card of this.modeCards) {
      card.classList.toggle('active', card.dataset.mode === id);
    }
    if (this.startBtn) {
      const labels = {
        campaign: '开始闯关',
        endless: '进入无尽',
        defense: '开始守城（十轮）',
        defense_endless: '无尽守城',
        awakening: '进入觉醒模式',
      };
      this.startBtn.textContent = labels[id] || '开始闯关';
    }
  }

  _bindNav() {
    if (!this.nav) return;
    this.nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      this.showTab(btn.dataset.tab);
    });
  }

  /** 切换到指定标签页（battle / mech / talent / stats / settings） */
  showTab(name) {
    if (!this.pages[name]) return;
    this.activeTab = name;
    for (const [key, page] of Object.entries(this.pages)) {
      if (page) page.classList.toggle('active', key === name);
    }
    if (this.nav) {
      for (const btn of this.nav.querySelectorAll('.nav-item')) {
        btn.classList.toggle('active', btn.dataset.tab === name);
      }
    }
  }

  /** 每次打开大厅时回到作战页 */
  resetTab() {
    this.showTab('battle');
  }

  /** 顶部资源显示（由存档驱动） */
  setResources(cores, coins, reputation = 0) {
    if (this.cores) this.cores.textContent = String(cores);
    if (this.coins) this.coins.textContent = String(coins);
    if (this.reputation) this.reputation.textContent = String(reputation);
  }

  /** 战绩页数值（已废弃，测试房取代战绩页，保留空实现以兼容调用） */
  setStats() {}

  // ---------------- 局外成长：机甲 / 天赋 / 属性 ----------------
  /**
   * 绑定成长数据与操作回调，并立即渲染一次。
   * @param {{save:object, onUnlockMech:Function, onUpgradeTalent:Function, onAllocate:Function}} growth
   */
  bindGrowth(growth) {
    this.growth = growth;
    this.growthCards = Array.from(document.querySelectorAll('.mech-card[data-mech]'));
    this.talentCards = Array.from(document.querySelectorAll('.talent-branch[data-branch]'));
    this.attrGrid = document.getElementById('lobby-attrs');
    this.lvEl = document.getElementById('lobby-level');
    this.xpEl = document.getElementById('lobby-xp');
    this.pointsEl = document.getElementById('lobby-points');

    for (const card of this.growthCards) {
      card.querySelector('.mech-buy')?.addEventListener('click', () => {
        const id = card.dataset.mech;
        const res = this.growth.onUnlockMech?.(id);
        if (res?.message) this._feedback(card, res.message);
        this.renderGrowth();
      });
    }
    for (const card of this.talentCards) {
      card.querySelector('.talent-up')?.addEventListener('click', () => {
        const branch = card.dataset.branch;
        const res = this.growth.onUpgradeTalent?.(branch);
        if (res?.message) this._feedback(card, res.message);
        this.renderGrowth();
      });
    }
    if (this.attrGrid) {
      this.attrGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-attr]');
        if (!btn) return;
        this.growth.onAllocate?.(btn.dataset.attr);
        this.renderGrowth();
      });
    }
    this.renderGrowth();
  }

  /** 根据存档刷新机甲卡 / 天赋节点 / 等级与属性 */
  renderGrowth() {
    const save = this.growth?.save;
    if (!save) return;
    const p = save.getProgress();
    if (this.lvEl) this.lvEl.textContent = p.max ? `Lv.${p.level} · 满级` : `Lv.${p.level}`;
    if (this.xpEl) this.xpEl.textContent = p.max ? '经验已满' : `${p.xp}/${p.next} EXP`;
    if (this.pointsEl) this.pointsEl.textContent = `属性点 ${p.points}`;

    for (const card of this.growthCards || []) {
      const id = card.dataset.mech;
      const def = MECHS[id];
      if (!def) continue;
      const unlocked = save.hasMech(id);
      const gate = MECH_GATES[id];
      card.classList.toggle('locked', !unlocked);
      const cost = card.querySelector('.mech-cost');
      const btn = card.querySelector('.mech-buy');
      if (cost) {
        const gateText = gate ? ` · 解锁消耗：${save.requirementText(gate)}` : '';
        cost.textContent = unlocked
          ? '已解锁 · 局内 TAB 召唤'
          : `${def.cost.coins} 金币 + ${def.cost.mecha} 机甲材料${gateText}`;
      }
      if (btn) {
        btn.textContent = unlocked ? '已解锁' : '解锁';
        btn.disabled = unlocked;
      }
    }

    for (const card of this.talentCards || []) {
      const branch = card.dataset.branch;
      const def = TALENTS[branch];
      const lv = save.data.talents[branch] || 0;
      const lvEl = card.querySelector('.talent-lv');
      if (lvEl) lvEl.textContent = `${lv}/${def.costs.length}`;
      card.querySelectorAll('.talent-nodes i').forEach((pip, i) => {
        pip.classList.toggle('on', i < lv);
      });
      const btn = card.querySelector('.talent-up');
      if (btn) {
        const cost = talentCost(branch, lv);
        btn.textContent = cost ? `升级（${cost.coins} 金币 + ${cost.awaken} 觉醒材料）` : '已满级';
        btn.disabled = !cost;
      }
    }

    if (this.attrGrid) {
      const perm = save.data.permanent;
      this.attrGrid.innerHTML = Object.values(ATTRIBUTES).map((def) => {
        const cur = perm[def.id] || 0;
        const can = p.points > 0 && cur < def.max;
        return `
          <div class="growth-attr">
            <div class="growth-attr-name">${def.name} <b>${cur}/${def.max}</b></div>
            <div class="growth-attr-desc">${def.desc} / 点</div>
            <button class="btn growth-attr-add" data-attr="${def.id}" ${can ? '' : 'disabled'}>+1</button>
          </div>`;
      }).join('');
    }
  }

  /** 卡片上的临时提示（3 秒后淡出） */
  _feedback(card, text) {
    let tip = card.querySelector('.growth-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'growth-tip';
      card.appendChild(tip);
    }
    tip.textContent = text;
    tip.classList.add('show');
    clearTimeout(tip._timer);
    tip._timer = setTimeout(() => tip.classList.remove('show'), 3000);
  }
}
