/**
 * 设置面板（大厅「设置」标签页）
 *
 * 只负责：
 *  - 从 SaveManager 读写灵敏度 / 音量 / 键位；
 *  - 渲染键位表并提供"点击后按新键"的改键交互；
 *  - 通过 onChange 通知 Game 立即生效。
 */
import { KEY_ACTIONS, formatBind } from '../config/keybinds.js';

const MODIFIERS = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight',
]);

export class SettingsUI {
  /**
   * @param {{save: import('../core/SaveManager.js').SaveManager, onChange?: Function}} opts
   */
  constructor(opts) {
    this.save = opts.save;
    this.onChange = opts.onChange || (() => {});
    this.listening = null;         // 正在等待新按键的动作 id
    this._pendingMods = [];        // 捕获到的修饰键（Ctrl / Shift / Alt）
    this._actionEls = new Map();

    this.groupEl = document.getElementById('bind-groups');
    this.sensInput = document.getElementById('set-sens');
    this.sensValue = document.getElementById('set-sens-value');
    this.volInput = document.getElementById('set-vol');
    this.volValue = document.getElementById('set-vol-value');
    this.qualityGroup = document.getElementById('set-quality');
    this.resetBtn = document.getElementById('btn-reset-binds');

    this._buildRows();
    this._bindEvents();
    this.refresh();
  }

  // ---------------- 渲染 ----------------
  _buildRows() {
    if (!this.groupEl) return;
    this.groupEl.innerHTML = '';
    const boxes = new Map();

    for (const action of KEY_ACTIONS) {
      if (action.hidden) continue;
      let box = boxes.get(action.group);
      if (!box) {
        box = document.createElement('div');
        box.className = 'bind-group';
        const title = document.createElement('h4');
        title.textContent = action.group;
        box.appendChild(title);
        boxes.set(action.group, box);
        this.groupEl.appendChild(box);
      }

      const row = document.createElement('div');
      row.className = 'bind-row';
      const label = document.createElement('span');
      label.textContent = action.label;
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'bind-key';
      key.dataset.action = action.id;
      row.appendChild(label);
      row.appendChild(key);
      box.appendChild(row);

      this._actionEls.set(action.id, key);
    }
  }

  _bindEvents() {
    if (this.groupEl) {
      this.groupEl.addEventListener('click', (e) => {
        const chip = e.target.closest('.bind-key');
        if (!chip) return;
        e.preventDefault();
        this._startListening(chip.dataset.action);
      });
    }

    if (this.sensInput) {
      this.sensInput.addEventListener('input', () => {
        const v = Number(this.sensInput.value);
        this.save.setSetting('sens', v);
        this.sensValue.textContent = v.toFixed(4);
        this.onChange();
      });
    }

    if (this.volInput) {
      this.volInput.addEventListener('input', () => {
        const v = Number(this.volInput.value);
        this.save.setSetting('vol', v);
        this.volValue.textContent = Math.round(v * 100) + '%';
        this.onChange();
      });
    }

    if (this.qualityGroup) {
      this.qualityGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-quality]');
        if (!btn) return;
        this.save.setSetting('quality', btn.dataset.quality);
        this.refresh();
        this.onChange();
      });
    }

    if (this.resetBtn) {
      this.resetBtn.addEventListener('click', () => {
        this.save.resetBinds();
        this._cancelListening();
        this.refresh();
        this.onChange();
      });
    }

    // 捕获键盘：录制阶段优先于 Input，避免改键同时触发游戏操作
    window.addEventListener('keydown', (e) => {
      if (!this.listening) return;
      e.preventDefault();
      e.stopPropagation();
      const code = e.code;

      if (MODIFIERS.has(code)) {
        if (!this._pendingMods.includes(code)) this._pendingMods.push(code);
        return;
      }
      const combo = [...this._pendingMods, code].join('+');
      this._assign(this.listening, combo);
    }, true);

    // 只按修饰键（例如把疾跑绑成 Shift）：松开时直接绑定该修饰键
    window.addEventListener('keyup', (e) => {
      if (!this.listening) return;
      const code = e.code;
      if (!MODIFIERS.has(code)) return;
      if (this._pendingMods.length === 1 && this._pendingMods[0] === code) {
        e.preventDefault();
        this._assign(this.listening, code);
      }
    }, true);

    // 鼠标键也能改绑（左键 / 右键等）
    window.addEventListener('mousedown', (e) => {
      if (!this.listening) return;
      e.preventDefault();
      e.stopPropagation();
      this._assign(this.listening, 'Mouse' + e.button);
    }, true);
  }

  // ---------------- 改键 ----------------
  _startListening(actionId) {
    if (!actionId) return;
    if (this.listening === actionId) {
      this._cancelListening();
      return;
    }
    this._cancelListening();
    this.listening = actionId;
    this._pendingMods = [];
    const el = this._actionEls.get(actionId);
    if (el) {
      el.classList.add('listening');
      el.textContent = '按下按键…';
    }
  }

  _cancelListening() {
    if (this.listening) {
      const el = this._actionEls.get(this.listening);
      if (el) {
        el.classList.remove('listening');
        el.textContent = formatBind(this.save.data.settings.binds[this.listening]);
      }
    }
    this.listening = null;
    this._pendingMods = [];
  }

  _assign(actionId, code) {
    if (!actionId || !code) return;
    const binds = this.save.data.settings.binds;
    const old = binds[actionId];

    // 完全相同的组合键已被占用：交换，避免两个动作共用一个键
    for (const [other, bind] of Object.entries(binds)) {
      if (other !== actionId && bind === code) {
        binds[other] = old || bind;
      }
    }
    binds[actionId] = code;
    this.save.save();

    this._cancelListening();
    this.refresh();
    this.onChange();
  }

  // ---------------- 数值同步 ----------------
  refresh() {
    const s = this.save.data.settings;

    for (const [id, el] of this._actionEls) {
      if (el.classList.contains('listening')) continue;
      el.textContent = formatBind(s.binds[id]);
    }

    if (this.sensInput) {
      this.sensInput.value = String(s.sens);
      if (this.sensValue) this.sensValue.textContent = Number(s.sens).toFixed(4);
    }
    if (this.volInput) {
      this.volInput.value = String(s.vol);
      if (this.volValue) this.volValue.textContent = Math.round(Number(s.vol) * 100) + '%';
    }
    if (this.qualityGroup) {
      for (const btn of this.qualityGroup.querySelectorAll('button[data-quality]')) {
        btn.classList.toggle('on', btn.dataset.quality === (s.quality || 'high'));
      }
    }
  }
}
