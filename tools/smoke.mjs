/**
 * 冒烟测试：只验证「能加载 + 渲染稳定 + 无报错」，几秒出结果。
 *   node tools/smoke.mjs
 */
import { openSession, startServer, sleep } from './cdp.mjs';

const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'smoke', width: 1024, height: 576 });
try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  const ok = await c.waitFor('window.__game && window.__game.state === "lobby"', 60000);
  const t0 = Date.now();
  await c.frame(30);
  const dt = Date.now() - t0;
  const info = await c.evaluate('({ sw: window.__game._softwareGL, ao: window.__game.postfx.aoEnabled, state: window.__game.state })');
  console.log(`ready=${ok} 30frames=${dt}ms ${JSON.stringify(info)}`);
  console.log('console.error:', c.consoleErrors.slice(0, 5));
  console.log('exceptions:', c.exceptions.slice(0, 3));
  if (!ok || dt > 8000) process.exitCode = 1;
} finally {
  c.close();
  server.close();
  await sleep(120);
}
