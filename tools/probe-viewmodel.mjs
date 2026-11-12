/**
 * 第一人称视图 / 敌人外观 视觉探针：把枪模与僵尸摆到镜头前截图，并断言枪械不会被渲染成黑影。
 *   node tools/probe-viewmodel.mjs
 */
import { openSession, startServer, sleep } from './cdp.mjs';

const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'viewmodel', width: 1280, height: 720 });
const shots = [];
let pass = 0;
let fail = 0;
const rec = (label, ok, got = '') => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${got !== '' ? ` — ${got}` : ''}`);
};

try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await c.waitFor('window.__game && window.__game.state === "lobby"', 60000);
  await c.evaluate('window.__game.openLobbyPanel("battle")');
  await c.frame(2);
  await c.evaluate('document.getElementById("btn-start").click()');
  await c.waitFor('window.__game.state === "playing"', 10000);

  // 站到空旷处、面向北墙，排除掩体干扰
  await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(0, 0, 8);
    g.player.velocity.set(0, 0, 0);
    g.mouseLook.reset();
    g.enemies.enemies.forEach(e => { if (e.root) e.root.visible = false; });
    document.getElementById('tips')?.classList.add('hide');
  })()`);
  await c.frame(6);

  // 1) 枪械是否真的被光照亮（不再是纯黑影）
  const vm = await c.evaluate(`(() => {
    const g = window.__game;
    const v = g.weaponView;
    const meshes = [];
    v.model.traverse(o => { if (o.isMesh && o.visible) meshes.push(o); });
    const mats = meshes.map(m => m.material).filter(Boolean);
    const lit = mats.filter(m => m.isMeshStandardMaterial || m.isMeshPhysicalMaterial);
    return {
      hasEnv: !!g.scene.environment,
      envIntensity: lit.length ? Math.max(...lit.map(m => m.envMapIntensity ?? 1)) : 0,
      meshCount: meshes.length,
      matTypes: [...new Set(mats.map(m => m.type))],
      litRatio: mats.length ? lit.length / mats.length : 0,
      lights: g.scene.children.filter(o => o.isLight).length,
    };
  })()`);
  rec('场景已生成 PMREM 环境贴图（金属有反射，不会渲染成死黑）', vm.hasEnv === true, JSON.stringify(vm));
  rec('手持武器网格可见且材质为 PBR', vm.meshCount > 0 && vm.litRatio === 1, JSON.stringify(vm));
  rec('场景存在环境光 / 平行光', vm.lights >= 2, `lights=${vm.lights}`);

  // 2) 枪模三种 Y 朝向各截一张（人工比对枪口方向）
  for (const [name, yaw] of [['pi', Math.PI], ['half', Math.PI / 2], ['zero', 0]]) {
    await c.evaluate(`window.__game.weaponView.baseRot.set(${-0.18}, ${yaw}, 0.06)`);
    await c.frame(4);
    shots.push(await c.shot(`vm-yaw-${name}.png`));
  }
  await c.evaluate('window.__game.weaponView.baseRot.set(-0.18, Math.PI, 0.06)');
  await c.frame(3);
  shots.push(await c.shot('vm-default.png'));

  // 3) 手臂显示出来看看姿势
  await c.evaluate(`(() => {
    const v = window.__game.weaponView;
    v.model.traverse(o => { if (o.isMesh) o.visible = true; });
  })()`);
  await c.frame(6);
  shots.push(await c.shot('vm-arms-visible.png'));

  // 4) 敌人特写
  await c.evaluate(`(() => {
    const g = window.__game;
    const e = g.enemies.enemies[0];
    e.position.set(0, 0, 2.2);
    e.root.position.copy(e.position);
    e.root.visible = true;
    e.dead = false; e.deadTimer = 0; e.health = 100;
    e.state = 'idle';
    e.root.rotation.y = Math.PI;
    e.bar.visible = false;
    g.weaponView.model.visible = false;
  })()`);
  await c.frame(8);
  shots.push(await c.shot('enemy-closeup.png'));

  console.log(shots.join('\n'));
  console.log(`视图探针结果：${pass}/${pass + fail} 通过`);
  console.log('exceptions:', c.exceptions, c.consoleErrors);
  if (fail > 0) process.exitCode = 1;
} finally { c.close(); server.close(); await sleep(150); }
