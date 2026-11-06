/**
 * 输入管理：键盘、鼠标、指针锁定
 * 只负责采集原始输入，不处理游戏逻辑。
 *
 * 支持两层接口：
 *  1. 原始编码：isDown('KeyW') / consume('Space') —— 调试、特殊逻辑用；
 *  2. 动作映射：actionDown('forward') / consumeAction('reload')
 *     动作与按键的对应关系来自 config/keybinds.js，并可从设置界面改写。
 */
import { DEFAULT_BINDS, normalizeBinds } from '../config/keybinds.js';

/** 无论何时都不交给浏览器的功能键（避免 F5 刷新、F12 调试等打断游戏） */
const BLOCK_FUNCTION_KEYS = new Set(['F3', 'F4', 'F5', 'F6', 'F7', 'F11', 'F12']);

/** 游戏中要拦截的 Ctrl 组合键（浏览器刷新 / 保存 / 打印 / 搜索等） */
const BLOCK_CTRL_KEYS = new Set([
  'KeyS', 'KeyP', 'KeyO', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyN',
  'KeyL', 'KeyT', 'KeyU', 'KeyR', 'KeyI', 'KeyA', 'KeyC', 'KeyV', 'KeyX',
  'Digit0', 'Minus', 'Equal',
]);

export class Input {
  constructor(canvas, binds = DEFAULT_BINDS) {
    this.canvas = canvas;
    this.keys = new Set();          // 当前按下的按键（鼠标键编码为 Mouse0/Mouse1/Mouse2）
    this.pressed = new Set();       // 本帧刚按下的按键（边沿触发）
    this.mouseDown = false;         // 左键是否按住（兼容旧逻辑）
    this.dx = 0;                    // 本帧鼠标水平位移
    this.dy = 0;                    // 本帧鼠标垂直位移
    this.wheelDelta = 0;            // 本帧滚轮累计
    this.locked = false;
    this.enabled = false;           // 暂停 / 大厅时禁用视角与滚轮
    this.onLockChange = null;

    this.bindings = normalizeBinds(binds);
    this._boundCodes = new Set();
    this._rebuildBoundCodes();

    this._bind();
  }

  /** 更新键位映射（设置界面改键后立即调用） */
  setBindings(binds) {
    this.bindings = normalizeBinds(binds);
    this._rebuildBoundCodes();
  }

  _rebuildBoundCodes() {
    this._boundCodes.clear();
    for (const bind of Object.values(this.bindings)) {
      for (const code of String(bind).split('+')) {
        if (code) this._boundCodes.add(code);
      }
    }
  }

  _bind() {
    // 键盘
    window.addEventListener('keydown', (e) => {
      const code = e.code;
      // TAB 在本作里被绑定为「大厅面板」键：任何状态下都拦截浏览器焦点导航，
      // 否则面板打开时（input.enabled=false）按 TAB 会一边关面板、一边把焦点跳到别处。
      if (code === 'Tab') e.preventDefault();
      // 防止空格滚动页面 / 游戏中浏览器快捷键生效
      if (this.enabled) {
        const blocked = this._boundCodes.has(code)
          || BLOCK_FUNCTION_KEYS.has(code)
          || (e.ctrlKey && BLOCK_CTRL_KEYS.has(code));
        if (blocked) e.preventDefault();
      }
      if (!e.repeat) this.pressed.add(code);
      this.keys.add(code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // 鼠标按键（含右键开镜）
    this.canvas.addEventListener('mousedown', (e) => {
      const code = 'Mouse' + e.button;
      this.keys.add(code);
      this.pressed.add(code);
      if (e.button === 0) this.mouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.keys.delete('Mouse' + e.button);
      if (e.button === 0) this.mouseDown = false;
    });
    // 禁止右键菜单，保持沉浸感
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 滚轮（切枪用；阻止页面滚动 / Ctrl+滚轮缩放）
    this.canvas.addEventListener('wheel', (e) => {
      if (this.enabled) e.preventDefault();
      if (!this.enabled) return;
      this.wheelDelta += e.deltaY;
    }, { passive: false });

    // 鼠标移动（指针锁定后使用 movementX/Y；未锁定时同样累计，作为降级方案）
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this.dx += e.movementX || 0;
      this.dy += e.movementY || 0;
    });

    // 指针锁定状态
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        // 失去焦点时清空按键，避免“卡键”
        this.keys.clear();
        this.mouseDown = false;
        this.dx = this.dy = 0;
      }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      console.warn('[Input] 指针锁定失败，请点击画布重试');
    });

    // 浏览器失去焦点时自动解锁鼠标，避免"卡视角"
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
      this.dx = this.dy = 0;
      if (this.locked) this.releaseLock();
    });
  }

  /** 请求锁定鼠标 */
  requestLock() {
    if (!this.locked) {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  /** 释放鼠标 */
  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** 模式串（'ControlLeft+KeyR'）拆成需要同时按住的编码 */
  _codesFor(action) {
    const bind = this.bindings[action];
    if (!bind) return [];
    return String(bind).split('+').filter(Boolean);
  }

  /** 动作对应的按键是否全部按住 */
  actionDown(action) {
    const codes = this._codesFor(action);
    if (codes.length === 0) return false;
    for (const code of codes) {
      if (!this.keys.has(code)) return false;
    }
    return true;
  }

  /** 动作是否在本帧刚触发（组合键任一键的边沿即可） */
  actionPressed(action) {
    if (!this.actionDown(action)) return false;
    return this._codesFor(action).some((code) => this.pressed.has(code));
  }

  /** 消费动作的边沿触发，避免同一帧重复处理 */
  consumeAction(action) {
    if (!this.actionPressed(action)) return false;
    for (const code of this._codesFor(action)) this.pressed.delete(code);
    return true;
  }

  /** 是否按住某键（原始编码） */
  isDown(code) {
    return this.keys.has(code);
  }

  /** 本帧是否刚按下（消费型，原始编码） */
  consume(code) {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  /** 取出并清空鼠标位移 */
  consumeMouseDelta() {
    const d = { x: this.dx, y: this.dy };
    this.dx = this.dy = 0;
    return d;
  }

  /** 取出并清空滚轮累计（有正负） */
  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  /** 每帧结束清理 */
  endFrame() {
    this.pressed.clear();
  }
}
