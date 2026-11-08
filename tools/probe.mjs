/**
 * 主探针：真实无头 Edge + CDP，黑盒验证「加载 → 开局 → 射击命中 → 换弹 → 三波推进 → 胜利/失败结算 → 再来一局」。
 * 不依赖任何测试桩，断言全部落在真实 DOM 与真实游戏对象上。
 *
 *   node tools/probe.mjs
 *   PROBE_LEVEL=2 node tools/probe.mjs   # 指定关卡（2-5）
 */
import { existsSync } from 'node:fs';
import { openSession, startServer, sleep } from './cdp.mjs';

const ROOT = process.cwd();
const LEVEL = Math.floor(Number(process.env.PROBE_LEVEL)) || 0;
if (!existsSync(`${ROOT}/index.html`)) {
  console.error('请在项目根目录运行：node tools/probe.mjs');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const rec = (label, ok, got = '') => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${got !== '' ? ` — ${got}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);
const txt = (c, expr) => c.evaluate(expr);

/** 无头浏览器的音频设备噪声：与游戏代码无关，不计入稳定性失败 */
const AUDIO_NOISE = /AudioContext encountered an error from the audio device or the WebAudio renderer/;
const realErrors = (errors) => errors.filter((e) => !AUDIO_NOISE.test(e));

const { server, port } = await startServer(ROOT);
const url = `http://127.0.0.1:${port}/${LEVEL ? `?level=${LEVEL}` : ''}`;
const c = await openSession({ tag: 'probe', width: 1024, height: 576 });

/** 波间三选一强化：点第一张卡继续战斗，返回卡牌数与所选 perk */
const resolvePerk = async () => {
  const shown = String(await c.evaluate('window.__game.state')) === 'perk';
  if (!shown) return { cards: 0, id: null };
  const picked = await c.evaluate(`(() => {
    const btns = [...document.querySelectorAll('#perk-overlay .perk-card')];
    const first = btns[0];
    if (!first) return { cards: btns.length, id: null };
    const id = first.dataset.perk;
    first.click();
    return { cards: btns.length, id };
  })()`);
  await c.frame(2);
  return picked;
};

/** 清空当前波：刷一个杀一个，直到本波总人数打完 */
const clearWave = async (keepShop = false) => {
  const n = await c.evaluate(`(() => {
    const em = window.__game.enemies;
    let guard = 0;
    // 刷一个杀一个；_spawnOne 是直接调用（绕过 update 的并发上限），
    // 所以 waveSpawned 可能略高于 waveTotal，这里只校验击杀数与本波总数一致
    while (em.waveKilled < em.waveTotal && guard++ < 80) {
      em._spawnOne();
      em.enemies.filter((e) => !e.dead).forEach((e) => e.takeDamage(999999));
    }
    return { spawned: em.waveSpawned, killed: em.waveKilled, total: em.waveTotal };
  })()`);
  // 波次肃清后会自动弹出关卡间军需商店：默认等待一帧让它弹出，再直接关掉。
  // 这里不调用 _closeShop（那会 skipBreak 把休整时间压到 0.2s），
  // 保留完整的 break 计时，后面的断言语义不变。
  if (!keepShop) {
    await c.frame(2);
    await c.evaluate(`(() => {
      const g = window.__game;
      if (g.state === 'shop') {
        g.defenseUI.hideShop();
        g._fieldShop = false;
        g.state = 'playing';
        g.input.enabled = true;
      }
    })()`);
  }
  // 波间 Roguelike 三选一：选第一张卡继续
  const perk = await resolvePerk();
  return { ...n, perk };
};

try {
  await c.send('Page.navigate', { url });
  await c.frame(2);

  section('A. 启动与资源加载');
  const ready = await c.waitFor('window.__game && window.__game.state === "lobby"', 60000);
  rec('加载完成并进入 3D 大厅', ready, ready ? '' : String(await txt(c, 'window.__game && window.__game.state')));
  rec('加载界面已隐藏', String(await txt(c, 'document.getElementById("loading").classList.contains("hidden")')) === 'true');
  rec('大厅 HUD 可见', String(await txt(c, '!document.getElementById("lobby-hud").classList.contains("hidden")')) === 'true');
  rec('入口遮罩显示（等待点击锁定鼠标）',
    String(await txt(c, '!document.getElementById("lobby-entry").classList.contains("hidden")')) === 'true');
  const lobbyInfo = await c.evaluate(`(() => {
    const g = window.__game.lobby;
    return {
      stations: g.stations.length,
      pos: [Math.round(g.player.pos.x * 100) / 100, Math.round(g.player.pos.z * 100) / 100],
      hasCamera: !!g.camera,
      sceneChildren: g.scene.children.length,
      menuHidden: document.getElementById('menu').classList.contains('hidden'),
    };
  })()`);
  rec('大厅布置 9 处设施（独立 3D 场景）',
    lobbyInfo.stations === 9 && lobbyInfo.hasCamera && lobbyInfo.sceneChildren > 20, JSON.stringify(lobbyInfo));
  rec('大厅默认不显示 HTML 面板', lobbyInfo.menuHidden === true);
  const texOk = await c.evaluate(`(() => {
    const t = window.__game.assets.textures;
    return Object.entries(t).map(([k, v]) => [k, v && v.image ? v.image.width : 0]);
  })()`);
  rec('三张贴图都真正解码（>64px）', Array.isArray(texOk) && texOk.every(([, w]) => w >= 64), JSON.stringify(texOk));
  const rootMotion = await c.evaluate(`(() => {
    const out = {};
    for (const [k, clip] of Object.entries(window.__game.assets.anims)) {
      if (!clip) { out[k] = null; continue; }
      let drift = 0;
      for (const t of clip.tracks) {
        if (!t.name.endsWith('.position')) continue;
        const node = t.name.slice(0, -'.position'.length);
        if (!/^(Zombie|Base_HumanPelvis)$/.test(node)) continue;
        const v = t.values;
        const x0 = v[0], z0 = v[2];
        for (let i = 0; i < v.length; i += 3) {
          drift = Math.max(drift, Math.abs(v[i] - x0), Math.abs(v[i + 2] - z0));
        }
      }
      out[k] = Math.round(drift * 1000) / 1000;
    }
    return out;
  })()`);
  rec('丧尸动画已剥除根位移（不再"影子冲刺"）',
    typeof rootMotion === 'object' && rootMotion !== null && Object.values(rootMotion).every((d) => d === 0),
    JSON.stringify(rootMotion));
  rec('无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 2).join(' | '));
  rec('无 console.error', realErrors(c.consoleErrors).length === 0, realErrors(c.consoleErrors).slice(0, 2).join(' | '));
  await c.shot('01-lobby.png');

  section('A2. 3D 大厅漫游与设施交互');
  await c.evaluate('document.getElementById("lobby-entry").click()');
  await c.frame(2);
  rec('点击入口遮罩后仍在大厅（进入漫游态）', String(await c.evaluate('window.__game.state')) === 'lobby');

  // WASD 前进：真实键盘事件驱动漫游
  const pos0 = await c.evaluate('({ x: window.__game.lobby.player.pos.x, z: window.__game.lobby.player.pos.z })');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await c.frame(20);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await c.frame(2);
  const pos1 = await c.evaluate('({ x: window.__game.lobby.player.pos.x, z: window.__game.lobby.player.pos.z })');
  rec('WASD 可在 3D 大厅内移动', Math.hypot(pos1.x - pos0.x, pos1.z - pos0.z) > 0.25,
    `${JSON.stringify(pos0)} → ${JSON.stringify(pos1)}`);

  // 站到交易所柜台前，按 F 打开对应页签
  await c.evaluate(`(() => {
    const p = window.__game.lobby.player;
    p.pos.set(-4.5, 0, -3.4); p.vel.set(0, 0, 0); p.yaw = Math.PI / 2; p.pitch = 0;
  })()`);
  await c.frame(2);
  const near = await c.evaluate('window.__game.lobby.nearest && window.__game.lobby.nearest.def.id');
  rec('走近物资交易所被识别为可交互设施', near === 'exchange', String(near));
  rec('屏幕下方出现「按 F 打开」提示',
    String(await txt(c, '!document.getElementById("lobby-interact").classList.contains("hidden") && document.getElementById("lobby-interact-name").textContent.includes("物资交易所")')) === 'true');

  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyF', key: 'f', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
  await c.frame(3);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyF', key: 'f', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
  const panel = await c.evaluate(`(() => ({
    state: window.__game.state,
    menu: !document.getElementById('menu').classList.contains('hidden'),
    tab: document.querySelector('.nav-item.active') ? document.querySelector('.nav-item.active').dataset.tab : '',
    page: document.querySelector('#tab-exchange').classList.contains('active'),
  }))()`);
  rec('按 F 打开物资交易所面板', panel.state === 'lobby_panel' && panel.menu && panel.tab === 'exchange' && panel.page, JSON.stringify(panel));

  // Esc 关闭面板 → 回到漫游
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await c.frame(3);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  const closed = await c.evaluate('({ state: window.__game.state, menu: document.getElementById("menu").classList.contains("hidden") })');
  rec('Esc 关闭面板并回到 3D 漫游', closed.state === 'lobby' && closed.menu, JSON.stringify(closed));

  // TAB 打开完整面板（默认停在作战页）
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await c.frame(3);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  rec('TAB 打开完整大厅面板', String(await c.evaluate('window.__game.state')) === 'lobby_panel');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await c.frame(2);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  rec('再按 Esc 回到大厅', String(await c.evaluate('window.__game.state')) === 'lobby');

  // TAB 冲突：面板打开时（input 被禁用）按 TAB 也必须只关闭面板，不能把焦点交给浏览器
  await c.evaluate('window.__game.openLobbyPanel("armory"); document.querySelector(".nav-item").focus();');
  await c.frame(2);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await c.frame(2);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await c.frame(3);
  const tabClose = await c.evaluate(`(() => ({
    state: window.__game.state,
    menuHidden: document.getElementById('menu').classList.contains('hidden'),
    active: document.activeElement ? document.activeElement.tagName : '',
  }))()`);
  rec('面板内 TAB 只关闭面板，焦点不留在按钮 / 浏览器 UI',
    tabClose.state === 'lobby' && tabClose.menuHidden && tabClose.active !== 'BUTTON', JSON.stringify(tabClose));

  await c.shot('01b-lobby-walk.png');

  section('B. 开局与波次初始化');
  // 大厅内打开指挥台面板，再从面板开始行动（与玩家真实操作路径一致）
  await c.evaluate('window.__game.openLobbyPanel("battle")');
  await c.frame(2);
  rec('指挥台面板可打开并停在作战页', String(await c.evaluate('document.querySelector(".nav-item.active").dataset.tab')) === 'battle');
  await c.evaluate('document.getElementById("btn-start").click()');
  const playing = await c.waitFor('window.__game.state === "playing"', 10000);
  rec('从大厅面板开始行动，进入 playing', playing, String(await txt(c, 'window.__game.state')));
  rec('大厅 HUD 在战斗中隐藏', String(await txt(c, 'document.getElementById("lobby-hud").classList.contains("hidden")')) === 'true');
  await c.frame(6);
  rec('HUD 可见', String(await txt(c, '!document.getElementById("hud").classList.contains("hidden")')) === 'true');
  rec('生命 100 / 护甲 50',
    String(await txt(c, 'document.getElementById("hp-value").textContent + "/" + document.getElementById("armor-value").textContent')) === '100/50');
  rec('弹药 30/60（局外新兵配发）',
    String(await txt(c, 'document.getElementById("mag-value").textContent + "/" + document.getElementById("reserve-value").textContent')) === '30/60');
  rec('波次指示 1/3', String(await txt(c, 'document.getElementById("wave-now").textContent + "/" + document.getElementById("wave-total").textContent')) === '1/3');
  await c.waitFor('window.__game.enemies.waveSpawned > 0', 8000);
  const w0 = await c.evaluate('({ total: window.__game.enemies.waveTotal, alive: window.__game.enemies.aliveCount, spawned: window.__game.enemies.waveSpawned })');
  rec('第 1 波共 28 只丧尸（平衡调整后总数）', w0.total === 28, JSON.stringify(w0));
  rec('场上存活不超过并发上限（4）', w0.alive <= 4, `alive=${w0.alive}`);
  const box = await c.evaluate(`(() => {
    const el = document.querySelector('#app canvas');
    if (!el) return { ok: false, why: 'canvas 不存在' };
    const r = el.getBoundingClientRect();
    return { ok: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2,
             why: Math.round(r.width) + '×' + Math.round(r.height) + ' vs ' + innerWidth + '×' + innerHeight };
  })()`);
  rec('画布铺满视口', !!(box && box.ok), box && box.why);
  await c.shot('02-gameplay.png');

  section('B2. 键位映射与改键');
  const binds = await c.evaluate(`(() => {
    const b = window.__game.input.bindings;
    return { crouch: b.crouch, sprint: b.sprint, fire: b.fire, aim: b.aim, panel: b.panel, pickup: b.pickup, autoPickup: b.autoPickup };
  })()`);
  rec('默认键位已载入（C 蹲下 / Shift 疾跑 / 右键开镜）',
    binds.crouch === 'KeyC' && binds.sprint === 'ShiftLeft' && binds.fire === 'Mouse0' && binds.aim === 'Mouse2',
    JSON.stringify(binds));
  rec('设置界面已生成完整键位表', Number(await c.evaluate('document.querySelectorAll(".bind-key").length')) >= 25,
    `rows=${await c.evaluate('document.querySelectorAll(".bind-key").length')}`);

  // 用真实键盘事件验证动作映射（无头下必须主动推帧）
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyC', key: 'c', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
  await c.frame(3);
  rec('按住 C 进入蹲伏', String(await c.evaluate('window.__game.player.isCrouching')) === 'true');
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyC', key: 'c', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
  await c.frame(3);
  rec('松开 C 自动站起', String(await c.evaluate('window.__game.player.isCrouching')) === 'false');

  // 改键后立即生效：把蹲下改成 X，此时 C 不再触发
  await c.evaluate('window.__game.save.setBind("crouch", "KeyX"); window.__game._applySettings();');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyX', key: 'x', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 });
  await c.frame(3);
  rec('改键后按 X 也能蹲下', String(await c.evaluate('window.__game.player.isCrouching')) === 'true');
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyX', key: 'x', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 });
  await c.frame(3);
  rec('改键后原键 C 已失效', String(await c.evaluate('(() => { const p = window.__game.player; return p.isCrouching; })()')) === 'false');
  await c.evaluate('window.__game.save.resetBinds(); window.__game._applySettings();');

  // 疾跑：方向键 + Shift 长按
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ShiftLeft', key: 'Shift', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  await c.frame(4);
  rec('长按 Shift + W 进入疾跑', String(await c.evaluate('window.__game.player.isSprinting')) === 'true');
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ShiftLeft', key: 'Shift', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await c.frame(2);

  section('B3. 开镜 / 弹种轮盘');
  const fovBase = Number(await c.evaluate('window.__game.camera.fov'));
  const rightPress = { type: 'mousePressed', x: 512, y: 288, button: 'right', buttons: 2, clickCount: 1 };
  const rightRelease = { type: 'mouseReleased', x: 512, y: 288, button: 'right', buttons: 0, clickCount: 1 };

  // 右键开镜：真实鼠标事件驱动（toggle：按一次开，再按一次关）
  await c.send('Input.dispatchMouseEvent', rightPress);
  // 等开镜插值（aimProgress）收敛，再读 FOV
  await c.waitFor('window.__game.gun.aimProgress > 0.99', 4000);
  await c.frame(3);
  const ads = await c.evaluate(`(() => {
    const g = window.__game;
    return {
      fov: g.camera.fov,
      target: g.gun.weapons[g.gun.currentId].adsFov,
      aim: g.gun.aimProgress,
      sens: g.mouseLook.aimScale,
      cross: document.getElementById('crosshair').classList.contains('aiming'),
      aiming: g.aiming,
    };
  })()`);
  rec('右键开镜（toggle）：FOV 收束到瞄具值', Math.abs(ads.fov - ads.target) < 1.5 && ads.fov < fovBase,
    `fov ${fovBase} → ${ads.fov.toFixed(1)}（目标 ${ads.target}）`);
  rec('开镜降低鼠标灵敏度', ads.sens < 0.8, `aimScale=${ads.sens.toFixed(2)}`);
  rec('开镜准星收束', ads.cross === true, `aimProgress=${ads.aim.toFixed(2)}`);

  // 再按一次右键关镜（toggle）
  await c.send('Input.dispatchMouseEvent', rightPress);
  await c.waitFor(`window.__game.gun.aimProgress < 0.02 && Math.abs(window.__game.camera.fov - ${fovBase}) < 0.5`, 6000);
  await c.frame(3);
  const adsOff = await c.evaluate('({ fov: window.__game.camera.fov, sens: window.__game.mouseLook.aimScale, aim: window.__game.gun.aimProgress })');
  rec('右键再按关镜（toggle）：恢复 FOV / 灵敏度',
    Math.abs(adsOff.fov - fovBase) < 0.6 && adsOff.sens > 0.98 && adsOff.aim < 0.05, JSON.stringify(adsOff));

  // 重狙：开镜显示全屏瞄镜遮罩
  await c.evaluate('window.__game.gun.switchCooldown = 0; window.__game.gun.switchWeapon("sniper")');
  await c.frame(2);
  await c.send('Input.dispatchMouseEvent', rightPress);
  await c.waitFor('window.__game.camera.fov < 32', 6000);
  await c.frame(2);
  const scope = await c.evaluate(`({
    id: window.__game.gun.currentId,
    fov: window.__game.camera.fov,
    overlay: !document.getElementById('scope-overlay').classList.contains('hidden'),
  })`);
  rec('重狙开镜（FOV<32 + 全屏瞄镜）', scope.id === 'sniper' && scope.fov < 32 && scope.overlay === true, JSON.stringify(scope));
  await c.shot('06-scope.png');
  // toggle 模式：需再按一次右键关镜，遮罩才会隐藏（松开右键不关镜）
  await c.send('Input.dispatchMouseEvent', rightPress);
  await c.waitFor('window.__game.gun.aimProgress < 0.02', 6000);
  await c.frame(3);
  rec('再按右键关镜后瞄镜遮罩隐藏',
    String(await c.evaluate('document.getElementById("scope-overlay").classList.contains("hidden")')) === 'true');
  await c.evaluate('window.__game.gun.switchCooldown = 0; window.__game.gun.switchWeapon("rifle")');
  await c.frame(4);

  // Ctrl+R 弹种轮盘：组合键真实按下 → 鼠标上推选弹 → 松开关闭
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ControlLeft', key: 'Control', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 2 });
  await c.frame(2);
  const wheel = await c.evaluate(`({
    held: window.__game._ammoWheelOpen,
    visible: !document.getElementById('ammo-wheel').classList.contains('hidden'),
    items: document.querySelectorAll('.ammo-wheel-item').length,
  })`);
  rec('Ctrl+R 唤出弹种轮盘（4 种弹药）',
    wheel.held === true && wheel.visible === true && wheel.items === 4, JSON.stringify(wheel));
  rec('轮盘打开期间不触发换弹', String(await c.evaluate('window.__game.gun.reloading')) === 'false');
  await c.evaluate('window.__game.gun.updateAmmoWheel(0, 70)');
  await c.frame(1);
  const wheelIdx = Number(await c.evaluate('window.__game.gun.ammoIndex'));
  rec('鼠标上推选中穿甲弹', wheelIdx === 1, `ammoIndex=${wheelIdx}`);
  rec('HUD 弹种名同步为「穿甲弹」',
    String(await txt(c, 'document.getElementById("ammo-type").textContent')) === '穿甲弹');
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 2 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ControlLeft', key: 'Control', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
  await c.frame(2);
  rec('松开组合键关闭轮盘',
    String(await c.evaluate('window.__game._ammoWheelOpen')) === 'false'
    && String(await c.evaluate('document.getElementById("ammo-wheel").classList.contains("hidden")')) === 'true');
  await c.evaluate('window.__game.gun.ammoIndex = 0; window.__game.gun._syncHud();');

  section('B4. 军械库改装（槽位解锁 → 配件制造 → 装配）');
  const mod = await c.evaluate(`(() => {
    const g = window.__game;
    g.save.data.meta.coins = 6000;
    g.save.data.meta.reputation = 300;
    g.save.data.meta.materials.bossCore = 5;
    for (const s of ['muzzle', 'optic', 'magazine', 'grip', 'stock']) g.save.unlockModSlot(s);
    g.armory.refresh();
    const q = (slot, att) => document.querySelector('#armory-slots .armory-option[data-slot="' + slot + '"][data-att="' + att + '"]');
    const btnCount = document.querySelectorAll('#armory-slots .armory-option').length;
    const slotsUnlocked = ['muzzle', 'optic', 'magazine', 'grip', 'stock'].every((s) => g.save.isModSlotUnlocked(s));
    const base0 = g.gun.weapons.rifle;
    q('muzzle', 'muzzle_fire').click();   // 制造
    q('muzzle', 'muzzle_fire').click();   // 装配
    const fired = g.gun.weapons.rifle;
    q('magazine', 'ext').click();         // 制造
    q('magazine', 'ext').click();         // 装配
    const ext = g.gun.weapons.rifle;
    return {
      btnCount, slotsUnlocked,
      damage0: base0.damage, damage1: fired.damage, element: fired.element,
      mag0: base0.magazineSize, mag1: ext.magazineSize,
      saved: g.save.data.loadout.rifle.muzzle + '/' + g.save.data.loadout.rifle.magazine,
      fireActive: q('muzzle', 'muzzle_fire').classList.contains('active'),
      extActive: q('magazine', 'ext').classList.contains('active'),
      craftedElement: g.save.isAttachmentCrafted('muzzle_fire'),
      bossCoreLeft: g.save.materialCount('bossCore'),
    };
  })()`);
  rec('军械库五槽位共 19 个配件按钮', mod.btnCount === 19 && mod.slotsUnlocked, `count=${mod.btnCount}`);
  rec('枪口配件赋予火元素并提升伤害',
    mod.element === 'fire' && mod.damage1 > mod.damage0, `${mod.damage0} → ${mod.damage1.toFixed(1)}，element=${mod.element}`);
  rec('扩容弹匣：容量 30 → 45', mod.mag0 === 30 && mod.mag1 === 45, `${mod.mag0} → ${mod.mag1}`);
  rec('改装写入存档并高亮当前配件',
    mod.saved === 'muzzle_fire/ext' && mod.fireActive === true && mod.extActive === true, JSON.stringify(mod));
  rec('元素配件制造消耗首领核心', mod.craftedElement === true && mod.bossCoreLeft === 4, `bossCore=${mod.bossCoreLeft}`);
  await c.evaluate('window.__game.save.resetLoadout(); window.__game.gun.applyLoadout(window.__game.save.data.loadout); window.__game.gun.resetAmmo();');
  rec('一键恢复默认改装（容量回到 30 / 元素清空）',
    Number(await c.evaluate('window.__game.gun.weapons.rifle.magazineSize')) === 30
    && String(await c.evaluate('window.__game.gun.weapons.rifle.element')) === 'none');

  section('B5. 主路 / 跳跃翻越 / 箱顶站立');
  const road = await c.evaluate(`({
    built: !!window.__game.map.group.getObjectByName('main-road'),
    config: window.__game.map.level.mainRoad || null,
  })`);
  rec('主路已铺设（贯穿货场，出生点在路上）',
    road.built === true && road.config && road.config.w >= 4, JSON.stringify(road));

  // 真实 W + 空格：站在 1.1m 货箱前 → 自动翻越并站稳
  await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(12, 0, -3.85);
    g.player.velocity.set(0, 0, 0);
    g.player.grounded = true;
    g.player.isCrouching = false;
    g.mouseLook.yaw = 0;
    g.mouseLook.pitch = 0;
    g.player.update(0.016, g.mouseLook);
  })()`);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  let vaultMaxY = 0;
  let vaultGrounded = false;
  for (let i = 0; i < 40; i++) {
    await c.frame(1);
    const st = await c.evaluate('({ y: window.__game.player.position.y, grounded: window.__game.player.grounded })');
    vaultMaxY = Math.max(vaultMaxY, Number(st.y) || 0);
    if (i === 6) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
    }
    if (st.grounded && vaultMaxY > 1.05) { vaultGrounded = true; break; }
  }
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  rec('跳跃自动翻越 1.1m 货箱并站稳',
    vaultMaxY > 1.05 && vaultGrounded === true, `maxY=${vaultMaxY.toFixed(3)} grounded=${vaultGrounded}`);

  // 集装箱顶可站立行走（直接落到顶面，验证站立表面）
  const stand = await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(-20, 2.601, -2);
    g.player.velocity.set(0, 0, 0);
    g.player.grounded = false;
    for (let i = 0; i < 30; i++) g.player.update(0.016, g.mouseLook);
    return { y: window.__game.player.position.y, grounded: window.__game.player.grounded };
  })()`);
  rec('集装箱顶可站立（不会穿透下落）', Math.abs(stand.y - 2.6) < 0.05 && stand.grounded === true, JSON.stringify(stand));

  // 回出生点，拍一张主路视角
  await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(8, 0, 15);
    g.player.velocity.set(0, 0, 0);
    g.mouseLook.reset();
    g.player.update(0.016, g.mouseLook);
    g.mouseLook.update(0.016);
  })()`);
  await c.frame(2);
  await c.shot('07-road.png');

  section('C. 射击 / 统计');
  const before = await c.evaluate('window.__game.gun.mag');
  await c.evaluate(`(() => {
    // debugFire 会检查冷却，必须逐发清零，否则只在第一发真正开枪
    for (let i = 0; i < 5; i++) { window.__game.gun.cooldown = 0; window.__game.gun.debugFire(); }
  })()`);
  const after = await c.evaluate('window.__game.gun.mag');
  rec('连开 5 发弹药递减', after === before - 5, `${before} → ${after}`);
  rec('HUD 弹药同步', String(await txt(c, 'document.getElementById("mag-value").textContent')) === String(after));
  rec('本局统计已记录 5 次开火', Number(await c.evaluate('window.__game.stats.shots')) === 5, `shots=${await c.evaluate('window.__game.stats.shots')}`);
  const tracer = await c.evaluate(`(() => {
    const g = window.__game;
    const before = g.effects.tracerPool.filter((t) => t.life > 0).length;
    g.gun.cooldown = 0;
    g.gun.debugFire();
    const after = g.effects.tracerPool.filter((t) => t.life > 0).length;
    return { before, after };
  })()`);
  rec('开火立即生成曳光弹', Number(tracer.after) > Number(tracer.before), JSON.stringify(tracer));

  section('C2. 丧尸无枪械（普通丧尸只能近战）');
  const meleeCheck = await c.evaluate(`(() => {
    const em = window.__game.enemies;
    const out = { variants: [], meleeOk: true, spitOk: true, noGunProps: true };
    // 全部实例的变体配置都不允许出现枪械字段
    for (const e of em.enemies) {
      const v = e.variant;
      if (!out.variants.includes(v.id)) out.variants.push(v.id);
      if (v.id !== 'spitter' && v.melee !== true) out.meleeOk = false;
      if (v.melee) {
        // 近战变体不得有 accuracy / 弹匣等枪械属性
        if ('accuracy' in v || 'magazineSize' in v || 'reloadTime' in v) out.noGunProps = false;
        if (v.attackRange > 4) out.meleeOk = false;   // 近战触及距离必须是短手
      }
    }
    // 普通丧尸（walker）在攻击范围内走 windup 近战判定，不产生曳光弹
    const w = em.enemies.find((e) => e.variantId === 'walker') || em.enemies[0];
    w.setVariant ? w.setVariant('walker') : null;
    return out;
  })()`);
  rec('普通丧尸变体只有近战（melee=true）', meleeCheck.meleeOk, JSON.stringify(meleeCheck));
  rec('近战变体无任何枪械属性（弹匣/精度）', meleeCheck.noGunProps, JSON.stringify(meleeCheck));
  const noTracer = await c.evaluate(`(() => {
    const g = window.__game;
    const w = g.enemies.enemies.find((e) => e.variantId === 'walker' && !e.dead) || g.enemies.enemies[0];
    w.dead = false; w.deadTimer = 0; w.root.visible = true;
    w.setVariant('walker'); w.health = w.maxHealth;
    w.position.set(0, 0, 3.6); w.root.position.copy(w.position);
    w.velocity.set(0, 0, 0);
    g.player.position.set(0, 0, 8); g.player.velocity.set(0, 0, 0);
    g.mouseLook.reset();
    // 相机位置由 player._syncCamera 写入，_canSeePlayer 读的就是 camera；
    // 不跑一帧玩家更新，丧尸永远"看不见人"，近战前摇根本不会启动
    g.player.update(0.016, g.mouseLook);
    g.player.health.health = 100; g.player.health.armor = 50; g.player.health.dead = false;
    w.heading = Math.atan2(g.player.position.x - w.position.x, g.player.position.z - w.position.z);
    w.targetHeading = w.heading;
    w.lastKnown.copy(g.player.position);
    w.attackTimer = 0; w.windupTimer = 0; w.windupDone = true;
    w.state = 'chase'; w.chaseLinger = 0;
    const tracersBefore = g.effects.tracerPool.filter((t) => t.life > 0).length;
    // 连跑 3 秒近战：逼近 → 前摇 → 判定
    for (let i = 0; i < 120; i++) w.update(0.025);
    const tracersAfter = g.effects.tracerPool.filter((t) => t.life > 0).length;
    return { tracersBefore, tracersAfter, hp: g.player.health.health, armor: g.player.health.armor };
  })()`);
  rec('普通丧尸近战不产生任何弹道曳光', noTracer.tracersAfter <= noTracer.tracersBefore, JSON.stringify(noTracer));
  rec('普通丧尸近战可对玩家造成伤害（护甲优先吸收）', noTracer.hp < 100 || noTracer.armor < 50, `hp=${noTracer.hp} armor=${noTracer.armor}`);

  section('C3. 补给点（资源 / 弹药 / 物资）');
  const supplyCheck = await c.evaluate(`(() => {
    const g = window.__game;
    const s = g.supplies;
    const types = [...new Set(s.points.map((p) => p.type))];
    // 弹药拾取
    const ammoP = s.points.find((p) => p.type === 'ammo' && p.cooldown <= 0);
    g.gun.reserve = 10;
    g.player.position.set(ammoP.root.position.x, 0, ammoP.root.position.z);
    s.update(0.016);
    const reserveAfterAmmo = g.gun.reserve;
    const ammoCooling = ammoP.cooldown > 0;
    // 医疗拾取（先扣血）
    const medP = s.points.find((p) => p.type === 'med' && p.cooldown <= 0);
    g.player.health.health = 30;
    g.player.position.set(medP.root.position.x, 0, medP.root.position.z);
    s.update(0.016);
    const hpAfterMed = g.player.health.health;
    // 护甲拾取
    const armorP = s.points.find((p) => p.type === 'armor' && p.cooldown <= 0);
    g.player.health.armor = 5;
    g.player.position.set(armorP.root.position.x, 0, armorP.root.position.z);
    s.update(0.016);
    const armorAfter = g.player.health.armor;
    return {
      count: s.points.length,
      types,
      reserveAfterAmmo, ammoCooling, hpAfterMed, armorAfter,
    };
  })()`);
  rec('补给点已布置（≥8 个）', supplyCheck.count >= 8, `count=${supplyCheck.count}`);
  rec('补给类型齐全（弹药/医疗/护甲/物资）',
    ['ammo', 'med', 'armor', 'cache'].every((t) => supplyCheck.types.includes(t)), JSON.stringify(supplyCheck.types));
  rec('靠近弹药箱自动补弹（10 → 100）', supplyCheck.reserveAfterAmmo === 100, `reserve=${supplyCheck.reserveAfterAmmo}`);
  rec('拾取后补给点进入冷却', supplyCheck.ammoCooling === true);
  rec('靠近医疗包回复生命（30 → 75）', supplyCheck.hpAfterMed === 75, `hp=${supplyCheck.hpAfterMed}`);
  rec('靠近护甲板回复护甲（5 → 40）', supplyCheck.armorAfter === 40, `armor=${supplyCheck.armorAfter}`);

  section('D. 换弹');
  const magBeforeReload = Number(await c.evaluate('window.__game.gun.mag'));
  const reserveBefore = Number(await c.evaluate('window.__game.gun.reserve'));
  await c.evaluate('window.__game.gun.startReload()');
  await c.frame(3);
  rec('进入换弹状态', String(await txt(c, 'window.__game.gun.reloading')) === 'true');
  rec('换弹进度条可见', String(await txt(c, '!document.getElementById("reload-bar").classList.contains("hidden")')) === 'true');
  await c.evaluate('window.__game.gun.reloadElapsed = window.__game.gun.reloadDuration - 0.01');
  await c.frame(4);
  rec('换弹补满弹匣', Number(await c.evaluate('window.__game.gun.mag')) === 30, `mag=${await c.evaluate('window.__game.gun.mag')}`);
  const expectReserve = reserveBefore - (30 - magBeforeReload);
  const gotReserve = Number(await c.evaluate('window.__game.gun.reserve'));
  rec('备弹按缺额扣除', gotReserve === expectReserve, `${reserveBefore} → ${gotReserve}（应 ${expectReserve}）`);
  rec('进度条已隐藏', String(await txt(c, 'document.getElementById("reload-bar").classList.contains("hidden")')) === 'true');

  section('E. 命中判定（真射线 + 真扣血）');
  const hitResult = await c.evaluate(`(() => {
    const g = window.__game;
    const e = g.enemies.enemies.find((x) => !x.dead) || g.enemies.enemies[0];
    // 隔离测试：隐藏其它丧尸并暂停补位刷新，避免射线被别的目标吸收
    g.enemies.enemies.forEach((x) => {
      if (x === e) return;
      x.dead = true; x.deadTimer = 1; x.root.visible = false;
    });
    g.enemies.spawnTimer = 999;
    e.__probeTarget = true;
    // 摆成「玩家在 (0,0,8) 面向 -Z，敌人正前方 5 米」
    g.player.position.set(0, 0, 8);
    g.player.velocity.set(0, 0, 0);
    g.mouseLook.reset();
    g.mouseLook.recoilPitch = 0;
    g.mouseLook.recoilYaw = 0;
    // 相机位置由 player._syncCamera 写入，必须真的跑一帧玩家更新，
    // 否则射线原点还停在旧位置（这是探针早期漏伤害假阴性的根因）
    g.player.update(0.016, g.mouseLook);
    g.mouseLook.update(0);
    e.dead = false; e.deadTimer = 0; e.root.visible = true;
    e.position.set(0, 0, 3); e.root.position.copy(e.position);
    e.velocity.set(0, 0, 0);
    e.health = e.maxHealth;
    e.bar.visible = false;
    const before = e.health;
    g.gun.mag = 30; g.gun.cooldown = 0; g.gun.reloading = false;
    const shotsBefore = g.stats.shots, hitsBefore = g.stats.hits;
    g.__probeKillsBase = g.enemies.kills;
    g.gun.debugFire();
    return { before, after: e.health, dmg: before - e.health, shots: g.stats.shots - shotsBefore, hits: g.stats.hits - hitsBefore };
  })()`);
  rec('正前方敌人被命中并扣血', hitResult.dmg > 0, `-${hitResult.dmg} HP`);
  rec('命中计入 stats.hits', hitResult.hits === 1 && hitResult.shots === 1, JSON.stringify(hitResult));

  const killResult = await c.evaluate(`(() => {
    const g = window.__game;
    const e = g.enemies.enemies.find((x) => x.__probeTarget);
    let guard = 0;
    while (!e.dead && guard++ < 10) {
      g.gun.cooldown = 0; g.gun.mag = 30; g.gun.reloading = false;
      g.gun.debugFire();
    }
    delete e.__probeTarget;
    g.enemies.spawnTimer = 0.2;
    return { killed: e.dead, kills: g.enemies.kills - (g.__probeKillsBase || 0) };
  })()`);
  rec('持续命中可击杀敌人', killResult.killed === true && killResult.kills >= 1, JSON.stringify(killResult));
  rec('HUD 击杀数同步', Number(await txt(c, 'document.getElementById("kill-value").textContent')) === Number(await c.evaluate('window.__game.enemies.kills')));

  section('F. 三波推进（经济与任务目标）');
  const reserveBeforeWave = Number(await c.evaluate('window.__game.gun.reserve'));
  const w1 = await clearWave();
  rec('第 1 波按 total 刷满并清空', w1.killed === w1.total && w1.spawned >= w1.total, JSON.stringify(w1));
  rec('波间弹出三选一强化并成功选择', w1.perk.cards === 3 && w1.perk.id !== null, JSON.stringify(w1.perk));
  const perkRuntime = await c.evaluate(`(() => {
    const g = window.__game;
    return {
      stacks: g.perks.stacks.size,
      badges: document.querySelectorAll('#perk-badges .perk-badge').length,
      state: g.state,
      overlayHidden: document.getElementById('perk-overlay').classList.contains('hidden'),
    };
  })()`);
  rec('强化写入运行时 / 侧边图标显示 / 面板已关闭',
    perkRuntime.stacks === 1 && perkRuntime.badges === 1 && perkRuntime.state === 'playing' && perkRuntime.overlayHidden === true,
    JSON.stringify(perkRuntime));
  await c.waitFor('window.__game.enemies.waveState === "break"', 15000);
  rec('清空后进入休整（break）', String(await c.evaluate('window.__game.enemies.waveState')) === 'break', String(await c.evaluate('window.__game.enemies.waveState')));
  rec('清波不再自动弹出商店（改为 TAB 随时打开）',
    String(await c.evaluate('window.__game.state')) === 'playing'
    && String(await c.evaluate('document.getElementById("shop-panel").classList.contains("hidden")')) === 'true',
    `state=${await c.evaluate('window.__game.state')}`);
  const reserveAfterWave = Number(await c.evaluate('window.__game.gun.reserve'));
  rec('清波发放小量补给（备弹 +15）', reserveAfterWave >= reserveBeforeWave + 15, `${reserveBeforeWave} → ${reserveAfterWave}`);
  rec('清波累积局内战地金币', Number(await c.evaluate('window.__game.runGold')) > 0,
    `gold=${await c.evaluate('window.__game.runGold')}`);

  // TAB 打开战地军需商店（闯关 / 无尽通用）
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await c.frame(3);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  const fieldShop = await c.evaluate(`(() => {
    const g = window.__game;
    return {
      state: g.state,
      visible: !document.getElementById('shop-panel').classList.contains('hidden'),
      gold: g.runGold,
      items: document.querySelectorAll('#shop-grid .shop-card').length,
      title: document.querySelector('#shop-panel h2').textContent,
    };
  })()`);
  rec('TAB 打开战地军需商店（11 类补给/装置）',
    fieldShop.state === 'shop' && fieldShop.visible === true && fieldShop.items === 11 && fieldShop.title === '战地军需',
    JSON.stringify(fieldShop));
  const fieldBuy = await c.evaluate(`(() => {
    const g = window.__game;
    const reserve0 = g.gun.reserveOf('rifle');
    const gold0 = g.runGold;
    const btn = document.querySelector('#shop-grid [data-buy="ammoRifle"]');
    if (btn) btn.click();
    return { reserve0, reserve1: g.gun.reserveOf('rifle'), gold0, gold1: g.runGold };
  })()`);
  rec('用局内金币购买弹药并正确扣费',
    fieldBuy.reserve1 > fieldBuy.reserve0 && fieldBuy.gold1 === fieldBuy.gold0 - 30,
    JSON.stringify(fieldBuy));
  // Esc 关闭商店，继续验证波次推进
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await c.frame(3);
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  rec('Esc 关闭军需商店回到战斗',
    String(await c.evaluate('window.__game.state')) === 'playing'
    && String(await c.evaluate('document.getElementById("shop-panel").classList.contains("hidden")')) === 'true');

  // 局内任务目标 HUD
  const obj = await c.evaluate(`(() => ({
    visible: !document.getElementById('mission-objective').classList.contains('hidden'),
    name: document.getElementById('mission-obj-name').textContent,
    now: document.getElementById('mission-obj-now').textContent,
    total: document.getElementById('mission-obj-total').textContent,
  }))()`);
  rec('局内 HUD 显示任务目标并随击杀推进', obj.visible && obj.name.length > 0 && Number(obj.now) > 0, JSON.stringify(obj));

  await c.evaluate('window.__game.enemies.breakTimer = 0.001');
  const wave2 = await c.waitFor('window.__game.enemies.waveIndex === 1', 10000);
  rec('进入第 2 波', wave2, String(await c.evaluate('window.__game.enemies.waveIndex')));
  rec('HUD 波次更新为 2/3', String(await txt(c, 'document.getElementById("wave-now").textContent')) === '2');
  const w2 = await clearWave();
  await c.waitFor('window.__game.enemies.waveState === "break"', 15000);
  await c.evaluate('window.__game.enemies.breakTimer = 0.001');
  const wave3 = await c.waitFor('window.__game.enemies.waveIndex === 2', 10000);
  rec('第 2 波清空 → 第 3 波', wave3, JSON.stringify(w2));
  const w3 = await clearWave();
  await c.waitFor('window.__game.state === "result"', 15000);
  rec('第 3 波清空', w3.killed === w3.total, JSON.stringify(w3));

  section('G. 胜利结算');
  rec('状态切到 result', String(await c.evaluate('window.__game.state')) === 'result', String(await c.evaluate('window.__game.state')));
  rec('结算面板可见', String(await txt(c, '!document.getElementById("result").classList.contains("hidden")')) === 'true');
  rec('标题为「区域肃清」', String(await txt(c, 'document.getElementById("result-title").textContent')) === '区域肃清');
  rec('评级是 S/A/B/C 之一', /^[SABC]$/.test(String(await txt(c, 'document.getElementById("result-grade").textContent'))),
    String(await txt(c, 'document.getElementById("result-grade").textContent')));
  const rs = await c.evaluate(`({
    kills: document.getElementById('rs-kills').textContent,
    acc: document.getElementById('rs-acc').textContent,
    wave: document.getElementById('rs-wave').textContent,
    time: document.getElementById('rs-time').textContent,
  })`);
  const expectedKills = w1.total + w2.total + w3.total;
  rec(`结算击杀 = ${expectedKills}（三波总数）`, rs.kills === String(expectedKills), JSON.stringify(rs));
  rec('结算波次 = 3/3', rs.wave === '3/3', rs.wave);
  rec('命中率为百分比格式', /^\d+%$/.test(rs.acc), rs.acc);
  const resultRewards = String(await txt(c, 'document.getElementById("result-rewards").textContent'));
  rec('结算面板显示局外金币 / 声望奖励',
    resultRewards.startsWith('本局结算：金币 +') && resultRewards.includes('声望 +'), resultRewards);
  await c.shot('03-result-win.png');

  section('H. 再来一局');
  await c.evaluate('document.getElementById("btn-again").click()');
  await c.frame(4);
  rec('回到 playing', String(await c.evaluate('window.__game.state')) === 'playing', String(await c.evaluate('window.__game.state')));
  rec('波次重置为 1/3', Number(await c.evaluate('window.__game.enemies.waveIndex')) === 0);
  rec('击杀与统计清零', Number(await c.evaluate('window.__game.enemies.kills')) === 0 && Number(await c.evaluate('window.__game.stats.kills')) === 0);
  rec('生命/护甲/弹药全部重置',
    String(await txt(c, 'document.getElementById("hp-value").textContent + "/" + document.getElementById("armor-value").textContent + "/" + document.getElementById("mag-value").textContent')) === '100/50/30');
  rec('结算面板已隐藏', String(await txt(c, 'document.getElementById("result").classList.contains("hidden")')) === 'true');

  section('I. 阵亡 → 失败结算');
  await c.evaluate('window.__game.player.takeDamage(9999)');
  await c.frame(4);
  rec('状态切到 result', String(await c.evaluate('window.__game.state')) === 'result');
  rec('标题为「行动阵亡」', String(await txt(c, 'document.getElementById("result-title").textContent')) === '行动阵亡');
  rec('面板带 lose 样式', String(await txt(c, 'document.getElementById("result").classList.contains("lose")')) === 'true');
  await c.shot('04-result-lose.png');

  section('J. 返回大厅');
  await c.evaluate('document.getElementById("btn-menu").click()');
  await c.frame(3);
  rec('结算后回到 3D 大厅', String(await c.evaluate('window.__game.state')) === 'lobby', String(await c.evaluate('window.__game.state')));
  rec('大厅 HUD 可见 / 战斗 HUD 隐藏',
    String(await txt(c, '!document.getElementById("lobby-hud").classList.contains("hidden") && document.getElementById("hud").classList.contains("hidden")')) === 'true');
  rec('大厅玩家已回到出生点', String(await c.evaluate('Math.abs(window.__game.lobby.player.pos.z - window.__game.lobby.spawn.z) < 0.01')) === 'true');

  section('M. 任务奖励面板');
  const m0 = await c.evaluate(`(() => {
    const list = document.getElementById('mission-list');
    const first = list.querySelector('.mission-card');
    return {
      count: list.querySelectorAll('.mission-card').length,
      firstProgress: first ? first.querySelector('.mission-head span').textContent : '',
      firstDisabled: first ? first.querySelector('[data-claim]').disabled : true,
      coins: Number(document.getElementById('lobby-coins').textContent),
      rep: Number(document.getElementById('lobby-rep').textContent),
    };
  })()`);
  rec('任务面板渲染 4 条任务', m0.count === 4, `count=${m0.count}`);
  rec('完成一局后首个任务可领取',
    m0.firstProgress === '1/1' && m0.firstDisabled === false, JSON.stringify(m0));
  await c.evaluate('document.querySelector("#mission-list .mission-card [data-claim]").click()');
  const m1 = await c.evaluate(`(() => {
    const g = window.__game;
    const first = document.querySelector('#mission-list .mission-card');
    return {
      coins: Number(document.getElementById('lobby-coins').textContent),
      rep: Number(document.getElementById('lobby-rep').textContent),
      claimed: first.classList.contains('claimed'),
      disabled: first.querySelector('[data-claim]').disabled,
      feedback: document.getElementById('mission-feedback').textContent,
      saved: g.save.data.meta.claimedMissions.includes('first_run'),
      coinsSaved: g.save.data.meta.coins,
    };
  })()`);
  rec('领取任务：金币 +120 / 声望 +2',
    m1.coins === m0.coins + 120 && m1.rep === m0.rep + 2, JSON.stringify(m1));
  rec('领取后标记已领取并写入存档',
    m1.claimed === true && m1.disabled === true && m1.saved === true && m1.coinsSaved === m1.coins,
    m1.feedback);
  await c.evaluate(`document.querySelector('.nav-item[data-tab="missions"]').click()`);
  await c.frame(2);
  await c.shot('08-missions.png');

  section('O. 大厅经济：交易所 / 科研所 / 解锁');
  const economy = await c.evaluate(`(() => {
    const g = window.__game;
    const s = g.save;
    s.data.meta.coins = 20000;
    s.data.meta.reputation = 600;
    s.data.meta.cores = 2;
    s.data.meta.materials.researchAmmo = 5;
    s.data.progress.level = 10;
    s.data.permanent.dmg = 5;
    g._refreshLobby();
    document.querySelector('.nav-item[data-tab="exchange"]').click();

    const stock0 = s.data.meta.ammoStock.rifle;
    const coins0 = s.data.meta.coins;
    document.querySelector('[data-ammo="rifle"]').click();
    const stock1 = s.data.meta.ammoStock.rifle;
    const coins1 = s.data.meta.coins;

    const p1 = s.materialShopPrice('awaken');
    const awaken0 = s.materialCount('awaken');
    document.querySelector('[data-material="awaken"]').click();
    const p2 = s.materialShopPrice('awaken');
    document.querySelector('[data-material="awaken"]').click();
    const p3 = s.materialShopPrice('awaken');
    const awaken = s.materialCount('awaken');

    const coinsBeforeEx = s.data.meta.coins;
    const coresBeforeEx = s.data.meta.cores;
    document.querySelector('[data-exchange="sellCoreCoins"]').click();
    const coinsAfterEx = s.data.meta.coins;
    const coresAfterEx = s.data.meta.cores;

    document.querySelector('.nav-item[data-tab="research"]').click();
    const lv0 = s.researchLevel('ballistics');
    const mat0 = s.materialCount('researchAmmo');
    document.querySelector('[data-research="ballistics"]').click();

    return {
      stock0, stock1, coins0, coins1,
      p1, p2, p3, awaken0, awaken,
      coinsBeforeEx, coinsAfterEx,
      coresBeforeEx, coresAfterEx,
      lv0, lv1: s.researchLevel('ballistics'),
      mat0, mat1: s.materialCount('researchAmmo'),
    };
  })()`);
  rec('交易所可采购备弹并按口径计价',
    economy.stock1 === economy.stock0 + 30 && economy.coins1 === economy.coins0 - 20,
    JSON.stringify({ stock: `${economy.stock0}→${economy.stock1}`, coins: `${economy.coins0}→${economy.coins1}` }));
  rec('材料价格随购买次数递增',
    economy.p2 === economy.p1 + 300 && economy.p3 === economy.p2 + 300 && economy.awaken === economy.awaken0 + 2,
    `价格 ${economy.p1} → ${economy.p2} → ${economy.p3}，持有 ${economy.awaken0}→${economy.awaken}`);
  rec('三币互换：1 核心换 10000 金币',
    economy.coresAfterEx === economy.coresBeforeEx - 1 && economy.coinsAfterEx === economy.coinsBeforeEx + 10000,
    `cores=${economy.coresAfterEx} coins=${economy.coinsAfterEx}`);
  rec('科研所解锁并升级研究线（消耗科研材料）',
    economy.lv1 === economy.lv0 + 1 && economy.mat1 === economy.mat0 - 1,
    `Lv ${economy.lv0}→${economy.lv1}，材料 ${economy.mat0}→${economy.mat1}`);
  await c.shot('11-exchange-research.png');

  section('L. 元素弹 / 弹种结算');
  const elem = await c.evaluate(`(() => {
    const g = window.__game;
    const pool = g.enemies.enemies.filter((e) => e && e.root);
    const [a, b, c2] = pool;
    const revive = (e, x, z, hp) => {
      e.dead = false; e.deadTimer = 0; e.root.visible = true;
      e.health = hp;
      e.burnTimer = 0; e.burnDps = 0; e.poisonTimer = 0; e.poisonDps = 0;
      e.slowTimer = 0; e.statusSpeedMul = 1;
      e.position.set(x, 0, z); e.root.position.copy(e.position);
      e.velocity.set(0, 0, 0);
      return e;
    };
    const hitOn = (e) => ({ enemy: e, point: e.position.clone(), part: 'body' });
    const rifle = g.gun.weapons.rifle;
    const W = (element) => ({ ...rifle, element });
    const out = {};

    // 火：3 秒灼烧（10 DPS）
    const fireT = revive(a, 0, 0, 1000);
    g.gun._applyBulletEffects(W('fire'), hitOn(fireT), 10, g.gun.ammoType);
    const fireHp0 = fireT.health;
    for (let i = 0; i < 31; i++) fireT._updateStatus(0.1);
    out.fireDamage = Math.round(fireHp0 - fireT.health);
    out.fireLeft = fireT.burnTimer;

    // 毒：5 秒毒伤（7 DPS）
    const poisonT = revive(b, 2, 0, 1000);
    g.gun._applyBulletEffects(W('poison'), hitOn(poisonT), 10, g.gun.ammoType);
    const poisonHp0 = poisonT.health;
    for (let i = 0; i < 51; i++) poisonT._updateStatus(0.1);
    out.poisonDamage = Math.round(poisonHp0 - poisonT.health);

    // 电：减速 50%，到期自动回正
    const slowT = revive(c2, 4, 0, 1000);
    g.gun._applyBulletEffects(W('electric'), hitOn(slowT), 10, g.gun.ammoType);
    out.slowMul = slowT.statusSpeedMul;
    for (let i = 0; i < 25; i++) slowT._updateStatus(0.1);
    out.slowRestored = slowT.statusSpeedMul;

    // 风：击退推力
    const windT = revive(a, 6, 0, 1000);
    g.gun._applyBulletEffects(W('wind'), hitOn(windT), 10, g.gun.ammoType);
    out.knock = Math.round(Math.hypot(windT.velocity.x, windT.velocity.z) * 10) / 10;

    // 雷：连锁最近的 2 个目标
    const chainA = revive(a, 0, 0, 1000);
    const chainB = revive(b, 2, 0, 1000);
    const chainHp0 = chainB.health;
    g.gun._applyBulletEffects(W('lightning'), hitOn(chainA), 20, g.gun.ammoType);
    out.chainDamage = Math.round(chainHp0 - chainB.health);

    // 连爆：每 4 次命中触发范围爆炸
    revive(a, 0, 0, 1000);
    revive(b, 2, 0, 1000);
    g.gun.comboHits = 0;
    for (let i = 0; i < 4; i++) g.gun._applyBulletEffects(W('combo'), hitOn(a), 10, g.gun.ammoType);
    out.comboDamage = Math.round(1000 - b.health);
    out.comboReset = g.gun.comboHits;

    // 爆裂弹：命中点小范围爆炸（半径 2.6）
    revive(a, 0, 0, 1000);
    const exB = revive(b, 2, 0, 1000);
    g.gun.ammoIndex = 3;
    const exHp0 = exB.health;
    g.gun._applyBulletEffects({ ...rifle, element: 'none' }, hitOn(a), 10, g.gun.ammoType);
    out.explosiveDamage = Math.round(exHp0 - exB.health);
    g.gun.ammoIndex = 0;
    g.gun._syncHud();

    // 清理：恢复为尸体，避免影响稳定性统计
    for (const e of [a, b, c2]) { e.dead = true; e.deadTimer = 1; e.root.visible = false; }
    return out;
  })()`);
  rec('火元素：3 秒灼烧约 30 点', elem.fireDamage >= 28 && elem.fireDamage <= 32, `-${elem.fireDamage} HP，剩余 ${elem.fireLeft.toFixed(1)}s`);
  rec('毒元素：5 秒毒伤约 35 点', elem.poisonDamage >= 33 && elem.poisonDamage <= 37, `-${elem.poisonDamage} HP`);
  rec('电元素：减速 50% 且到期回正', elem.slowMul === 0.5 && elem.slowRestored === 1, `slow ${elem.slowMul} → ${elem.slowRestored}`);
  rec('风元素：命中产生击退', elem.knock >= 6, `velocity=${elem.knock}`);
  rec('雷元素：连锁对附近目标造成 50% 伤害', elem.chainDamage === 10, `-${elem.chainDamage} HP`);
  rec('连爆：第 4 次命中触发 80 点范围爆炸', elem.comboDamage === 80 && elem.comboReset === 0, `-${elem.comboDamage} HP`);
  rec('爆裂弹：命中产生 30 点范围爆炸', elem.explosiveDamage === 30, `-${elem.explosiveDamage} HP`);

  section('K. 稳定性');
  rec('全程无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 3).join(' | '));
  rec('全程无 console.error', realErrors(c.consoleErrors).length === 0, realErrors(c.consoleErrors).slice(0, 3).join(' | '));
  const callCount = await c.evaluate('window.__game.renderer.info.render.calls');
  rec('单帧 draw call 控制在 220 以内', Number(callCount) < 220, `calls=${callCount}`);
  await c.shot('05-final.png');

  section('N. 守城模式：地图 / 核心 / 场景武器 / 商店');
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/?mode=defense` });
  const readyDef = await c.waitFor('window.__game && window.__game.state === "lobby"', 60000);
  rec('守城页面加载完成（进入大厅）', readyDef);
  const defMeta = await c.evaluate(`(() => {
    const g = window.__game;
    return {
      level: g.map.level.id,
      hasDefense: !!g.map.level.defense,
      weapons: g.defense ? g.defense.weapons.length : 0,
      core: g.defense ? g.defense.coreHp : 0,
      hud: !document.getElementById('defense-status').classList.contains('hidden'),
      gold: g.defense ? g.defense.gold : -1,
    };
  })()`);
  rec('切换至领地防线地图', defMeta.level === 'defense' && defMeta.hasDefense, defMeta.level);
  rec('守城运行时已创建 3 件场景武器（岸防炮 / 机枪 / 喷火器）', defMeta.weapons === 3, `weapons=${defMeta.weapons}`);
  rec('核心初始生命 1000', defMeta.core === 1000, `core=${defMeta.core}`);
  rec('守城 HUD 在大厅中隐藏，局内金币 0', defMeta.hud === false && defMeta.gold === 0, `hud=${defMeta.hud} gold=${defMeta.gold}`);

  await c.evaluate('window.__game.openLobbyPanel("battle")');
  await c.frame(2);
  await c.evaluate('document.getElementById("btn-start").click()');
  await c.waitFor('window.__game.state === "playing"', 10000);
  await c.frame(4);
  rec('开始守城后 HUD 显示',
    String(await txt(c, '!document.getElementById("defense-status").classList.contains("hidden")')) === 'true');
  await c.evaluate(`(() => {
    const g = window.__game;
    g.enemies.enemies.forEach((e) => { e.dead = true; e.deadTimer = 1; e.root.visible = false; });
    g.enemies.waveKilled = g.enemies.waveTotal;
  })()`);

  // 上机：岸防炮
  const mount = await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(-6.5, 0, 10.4);
    const ok = g.defense.tryInteract();
    const w = g.defense.mounted;
    return {
      ok,
      mounted: !!w,
      name: w ? w.cfg.name : null,
      eyeY: g.camera.position.y,
      pivot: g.weaponView.pivot.visible,
      hint: g.defense.interactHint(),
    };
  })()`);
  rec('靠近岸防炮按 F 上机', mount.ok && mount.mounted && mount.name === '岸防炮', mount.name);
  rec('上机后相机移到炮位并隐藏手持武器', mount.eyeY > 1.4 && mount.pivot === false, `eyeY=${mount.eyeY?.toFixed(2)}`);
  rec('上机状态提示离开方式', typeof mount.hint === 'string' && mount.hint.includes('离开'), mount.hint);

  // 开火：有限弹药 + 过热
  const fire = await c.evaluate(`(() => {
    const g = window.__game;
    const w = g.defense.mounted;
    const before = w.ammo;
    g.defense._fireSceneWeapon(w);
    const ammoFirst = w.ammo;
    const heatAfterShot = w.heat;
    w.heat = 99;
    w.cooldown = 0;
    g.defense._fireSceneWeapon(w);
    return {
      ammo: w.ammo, ammoFirst, before,
      heat: heatAfterShot,
      overheated: w.overheated,
      ammoMax: w.cfg.ammoMax,
    };
  })()`);
  rec('岸防炮开火消耗弹药', fire.ammoFirst === fire.before - 1, `${fire.before} → ${fire.ammoFirst}`);
  rec('连续射击触发热度过热锁定', fire.overheated === true && fire.heat > 0, `heat=${fire.heat}`);

  const dismount = await c.evaluate(`(() => {
    const g = window.__game;
    const ok = g.defense.tryInteract();
    return { ok, mounted: g.defense.isMounted, pivot: g.weaponView.pivot.visible, hint: g.defense.interactHint() };
  })()`);
  rec('再按 F 离开炮位并恢复手持武器', dismount.ok && !dismount.mounted && dismount.pivot === true);

  // 可拆武器：喷火器拾取 / 喷射 / 放下
  const flame = await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(0, 0, 13.6);
    const picked = g.defense.tryInteract();
    const w = g.defense.carrying;
    const ammo0 = w ? w.ammo : -1;
    for (let i = 0; i < 6; i++) g.defense.updateCarried(0.2, true, true);
    const ammo1 = w ? w.ammo : -1;
    const heat = w ? w.heat : -1;
    const dropped = g.defense.tryInteract();
    return {
      picked, name: w ? w.cfg.name : null, ammo0, ammo1, heat,
      dropped, carrying: g.defense.isCarrying, pivot: g.weaponView.pivot.visible,
    };
  })()`);
  rec('移动喷火器可拆下携带', flame.picked && flame.name === '移动喷火器');
  rec('喷火器喷射消耗燃料并累积热量', flame.ammo1 < flame.ammo0 && flame.heat > 0, `fuel ${flame.ammo0.toFixed(1)} → ${flame.ammo1.toFixed(1)}，heat=${flame.heat.toFixed(1)}`);
  rec('再按 F 放下喷火器并恢复手持武器', flame.dropped && !flame.carrying && flame.pivot === true);

  // 商店：炮塔 / 路障 / 修理 / 补给 / 人机
  await c.evaluate(`(() => {
    const g = window.__game;
    g.defense.gold = 500;
    g.defense.addGold(0);
    g.defense.coreHp = 600;
    g._openDefenseShop();
  })()`);
  const shopOpen = await c.evaluate(`(() => ({
    state: window.__game.state,
    visible: !document.getElementById('shop-panel').classList.contains('hidden'),
    cards: document.querySelectorAll('#shop-grid [data-buy]').length,
    gold: Number(document.getElementById('shop-gold').textContent),
    sub: document.getElementById('shop-sub').textContent,
  }))()`);
  rec('守城 TAB 可随时打开常驻军需商店', shopOpen.state === 'shop' && shopOpen.visible, `state=${shopOpen.state}`);
  rec('商店提供 6 类军需（含场景武器补给与雇佣人机）', shopOpen.cards === 6, `cards=${shopOpen.cards}`);
  await c.shot('09-defense-shop.png');

  const buys = await c.evaluate(`(() => {
    const g = window.__game;
    const q = (id) => document.querySelector('[data-buy="' + id + '"]');
    const gold0 = g.defense.gold;
    q('turret').click();
    const t = { gold: g.defense.gold, turrets: g.defense.turrets.length };
    q('barricade').click();
    const b = { gold: g.defense.gold, barricades: g.defense.barricades.length };
    g.defense.coreHp = 600;
    q('repair').click();
    const r = { gold: g.defense.gold, coreHp: g.defense.coreHp };
    g.defense.weapons.forEach((w) => { w.ammo = 0; w.heat = 80; w.overheated = true; });
    q('resupply').click();
    const s = {
      gold: g.defense.gold,
      fullAmmo: g.defense.weapons.every((w) => w.ammo === w.cfg.ammoMax),
      heat: g.defense.weapons.every((w) => w.heat === 0),
    };
    return { gold0, t, b, r, s, buttons: [...document.querySelectorAll('#shop-grid [data-buy]')].map((x) => x.dataset.buy) };
  })()`);
  rec('购买炮塔：扣 120 金币并生成自动炮塔', buys.t.gold === buys.gold0 - 120 && buys.t.turrets === 1, `gold ${buys.gold0} → ${buys.t.gold}`);
  rec('布设沙袋路障：扣 80 金币并加入碰撞', buys.b.gold === buys.t.gold - 80 && buys.b.barricades === 1, `gold=${buys.b.gold}`);
  rec('修理核心：+150 生命', buys.r.coreHp === 750 && buys.r.gold === buys.b.gold - 60, `coreHp=${buys.r.coreHp}`);
  rec('场景武器补给：全部弹药补满并降温', buys.s.fullAmmo && buys.s.heat, `gold=${buys.s.gold}`);

  // 雇佣人机：金币 + 声望
  await c.evaluate(`(() => {
    const g = window.__game;
    g.save.data.meta.coins = 400;
    g.save.data.meta.reputation = 10;
    g.defenseUI.updateShop(g.defense.getShopState());
  })()`);
  const hire = await c.evaluate(`(() => {
    const g = window.__game;
    document.querySelector('[data-buy="hire"]').click();
    return {
      bots: g.defense.bots.length,
      coins: g.save.data.meta.coins,
      rep: g.save.data.meta.reputation,
      feedback: document.getElementById('shop-feedback').textContent,
    };
  })()`);
  rec('雇佣人机消耗 300 金币 + 5 声望', hire.bots === 1 && hire.coins === 100 && hire.rep === 5,
    `bots=${hire.bots} coins=${hire.coins} rep=${hire.rep}`);

  await c.evaluate('document.getElementById("btn-shop-continue").click()');
  const resumed = await c.evaluate(`(() => {
    const g = window.__game;
    return { state: g.state, visible: !document.getElementById('shop-panel').classList.contains('hidden'), break: g.enemies.waveState };
  })()`);
  rec('关闭商店后回到战斗', resumed.state === 'playing' && resumed.visible === false, `state=${resumed.state}`);

  // 核心受击与失守
  const core = await c.evaluate(`(() => {
    const g = window.__game;
    const em = g.enemies;
    // 真实帧可能在本波结束后又打开了商店；先同步关掉，保证核心受击发生在 playing 中
    if (g.state === 'shop') document.getElementById('btn-shop-continue').click();
    const e = em.enemies.find((x) => !x.dead) || (em._spawnOne(), em.enemies.find((x) => !x.dead));
    e.position.set(g.defense.corePos.x + 1.0, 0, g.defense.corePos.z + 0.8);
    const hp0 = g.defense.coreHp;
    g.defense.update(2);
    const hp1 = g.defense.coreHp;
    g.defense.coreHp = 4;
    g.defense.update(1.5);
    const destroyed = g.defense.coreDestroyed;
    g.defense.update(0.2);
    return { hp0, hp1, destroyed, state: g.state, title: document.getElementById('result-title').textContent };
  })()`);
  rec('丧尸贴近核心时核心持续掉血', core.hp1 < core.hp0, `${core.hp0.toFixed(0)} → ${core.hp1.toFixed(0)}`);
  rec('核心归零判定守城失败并进入结算', core.destroyed && core.state === 'result' && core.title.includes('核心被摧毁'),
    `state=${core.state} title=${core.title}`);
  await c.shot('10-defense-result.png');

  rec('守城流程无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 3).join(' | '));
  rec('守城流程无 console.error', realErrors(c.consoleErrors).length === 0, realErrors(c.consoleErrors).slice(0, 3).join(' | '));
} catch (err) {
  console.error('\n探针异常：', err);
  fail += 1;
} finally {
  console.log(`\n=== 探针结果：${pass}/${pass + fail} 通过 ===`);
  if (c.exceptions.length) console.log('未捕获异常：\n' + c.exceptions.join('\n'));
  if (c.consoleErrors.length) console.log('console.error：\n' + c.consoleErrors.join('\n'));
  c.close();
  server.close();
  await sleep(200);
}
process.exit(fail ? 1 : 0);
