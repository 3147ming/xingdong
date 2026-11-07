/**
 * 默认键位与按键显示名
 *
 * 所有可改键动作集中在这里：id 是代码里使用的动作名，
 * def 是 keyboard event.code / 鼠标键编码（Mouse0 左键、Mouse2 右键）。
 * 组合键用 "+" 连接，例如 Ctrl+R = 'ControlLeft+KeyR'。
 *
 * 隐藏动作（hidden: true）仍然参与输入判定，但不会出现在设置界面。
 */

export const KEY_ACTIONS = [
  // ---- 移动 ----
  { id: 'forward', label: '前进', group: '移动', def: 'KeyW' },
  { id: 'backward', label: '后退', group: '移动', def: 'KeyS' },
  { id: 'left', label: '左移', group: '移动', def: 'KeyA' },
  { id: 'right', label: '右移', group: '移动', def: 'KeyD' },
  { id: 'jump', label: '跳跃', group: '移动', def: 'Space' },
  { id: 'sprint', label: '疾跑（长按）', group: '移动', def: 'ShiftLeft' },
  { id: 'walk', label: '静步（长按）', group: '移动', def: 'AltLeft' },
  { id: 'crouch', label: '蹲下（长按）', group: '移动', def: 'KeyC' },

  // ---- 战斗 ----
  { id: 'fire', label: '射击', group: '战斗', def: 'Mouse0' },
  { id: 'aim', label: '开镜', group: '战斗', def: 'Mouse2' },
  { id: 'reload', label: '换弹', group: '战斗', def: 'KeyR' },
  { id: 'weapon1', label: '切枪 1', group: '战斗', def: 'Digit1' },
  { id: 'weapon2', label: '切枪 2', group: '战斗', def: 'Digit2' },
  { id: 'weapon3', label: '切枪 3', group: '战斗', def: 'Digit3' },
  { id: 'weapon4', label: '切枪 4', group: '战斗', def: 'Digit4' },
  { id: 'weapon5', label: '切枪 5', group: '战斗', def: 'Digit5' },
  { id: 'ammoWheel', label: '弹种轮盘', group: '战斗', def: 'ControlLeft+KeyR' },

  // ---- 交互 ----
  { id: 'pickup', label: '拾取', group: '交互', def: 'KeyF' },
  { id: 'autoPickup', label: '自动拾取开关', group: '交互', def: 'KeyP' },
  { id: 'backpack', label: '背包', group: '交互', def: 'KeyB' },

  // ---- 技能（Q E T Y U I O，机制后续接入）----
  { id: 'skill1', label: '技能 1', group: '技能', def: 'KeyQ' },
  { id: 'skill2', label: '技能 2', group: '技能', def: 'KeyE' },
  { id: 'skill3', label: '技能 3', group: '技能', def: 'KeyT' },
  { id: 'skill4', label: '技能 4', group: '技能', def: 'KeyY' },
  { id: 'skill5', label: '技能 5', group: '技能', def: 'KeyU' },
  { id: 'skill6', label: '技能 6', group: '技能', def: 'KeyI' },
  { id: 'skill7', label: '技能 7', group: '技能', def: 'KeyO' },

  // ---- 界面 ----
  { id: 'panel', label: '军需商店 / 大厅面板', group: '界面', def: 'Tab' },
  { id: 'growth', label: '成长面板（机甲 / 天赋 / 觉醒）', group: '界面', def: 'KeyV' },
  { id: 'map', label: '地图', group: '界面', def: 'Backquote' },
  { id: 'pause', label: '暂停 / 返回', group: '界面', def: 'Escape' },

  // ---- 调试（不在设置界面显示）----
  { id: 'debugFps', label: '帧率面板', group: '调试', def: 'F1', hidden: true },
];

/** 由动作表直接生成默认键位对象 */
export const DEFAULT_BINDS = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a.def]));

export const KEY_GROUPS = ['移动', '战斗', '交互', '技能', '界面'];

/** 允许出现在键位表里的动作 id */
export const ACTION_IDS = KEY_ACTIONS.map((a) => a.id);

const CODE_NAMES = {
  Space: '空格',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  Backquote: '·',
  Escape: 'Esc',
  Tab: 'Tab',
  Enter: '回车',
  Mouse0: '鼠标左键',
  Mouse1: '鼠标中键',
  Mouse2: '鼠标右键',
};

/**
 * 把内部编码转成界面上的按键名
 * @param {string} bind 例如 'KeyW' / 'ControlLeft+KeyR' / 'Mouse0'
 */
export function formatBind(bind) {
  if (!bind) return '未绑定';
  return bind.split('+').map((code) => {
    if (CODE_NAMES[code]) return CODE_NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    return code;
  }).join(' + ');
}

/** 过滤脏数据：只保留已知动作，值必须是短字符串 */
export function normalizeBinds(source = {}) {
  const out = {};
  for (const id of ACTION_IDS) {
    const v = source ? source[id] : undefined;
    out[id] = (typeof v === 'string' && v.length > 0 && v.length <= 40)
      ? v
      : DEFAULT_BINDS[id];
  }
  return out;
}
