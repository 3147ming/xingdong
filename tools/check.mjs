/**
 * 离线静态完整性检查（零依赖，不走浏览器）
 *
 * 检查范围：
 *   1. 顶层必需文件 / 目录是否存在
 *   2. 关键资源（FBX / WebP / MP3）文件大小是否正常（>0）
 *   3. 源码 import 路径能否解析到实际文件
 *   4. package.json 声明的脚本入口文件是否存在
 *   5. HTML 的 link / script 引用路径是否可达
 *
 * 用法：node tools/check.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const me = fileURLToPath(import.meta.url);
if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('请在项目根目录运行：node tools/check.mjs');
  process.exit(2);
}

let pass = 0;
let fail = 0;

const section = (t) => console.log(`\n=== ${t} ===`);
const rec = (label, ok, detail = '') => {
  if (ok) pass += 1; else fail += 1;
  const mark = ok ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`  ${mark} ${label}${detail ? ' — ' + detail : ''}`);
};
const pathExists = (p) => existsSync(join(ROOT, p));
const sizeOk = (p, minBytes = 1) => {
  try {
    return statSync(join(ROOT, p)).size >= minBytes;
  } catch { return false; }
};

// ============================================================
section('A. 顶层骨架');

const TOP_FILES = [
  'index.html', 'package.json', 'server.mjs',
  '.gitignore', '.nojekyll', '_headers', 'DEPLOY.md',
];
for (const f of TOP_FILES) {
  rec(`${f} 存在`, pathExists(f));
}

const TOP_DIRS = ['src', 'styles', 'vendor', 'public', 'tests', 'tools'];
for (const d of TOP_DIRS) {
  rec(`${d}/ 目录存在`, pathExists(d));
}

// ============================================================
section('B. package.json 声明与实际文件匹配');

let pkg;
try { pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')); }
catch { pkg = null; }
rec('package.json 可解析', !!pkg);

if (pkg?.scripts) {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    // node tools/xxx.mjs → 检查 tools/xxx.mjs 是否存在
    const m = cmd.match(/node\s+(\S+\.mjs)/);
    if (m) {
      const f = m[1];
      rec(`scripts.${name} 入口 ${f} 存在`, pathExists(f), pathExists(f) ? '' : '缺失');
    }
  }
}

// ============================================================
section('C. 源码模块存在性（src/）');

const SRC_MODULES = [
  'main.js',
  'config/weapon.js', 'config/modes.js', 'config/keybinds.js', 'config/mods.js', 'config/economy.js',
  'config/growth.js',
  'core/Game.js', 'core/AssetManager.js', 'core/AudioManager.js',
  'core/CollisionWorld.js', 'core/Input.js', 'core/scoring.js', 'core/SaveManager.js',
  'player/MouseLook.js', 'player/PlayerController.js', 'player/PlayerHealth.js', 'player/MechSystem.js',
  'weapons/GunSystem.js', 'weapons/WeaponView.js', 'weapons/Effects.js', 'weapons/CasingSystem.js',
  'enemies/EnemyManager.js', 'enemies/EnemyAI.js',
  'world/OutdoorMap.js', 'world/MapBuilder.js', 'world/levels.js', 'world/SupplyManager.js',
  'world/DefenseManager.js', 'world/LobbyScene.js',
  'ui/HUD.js', 'ui/Menu.js', 'ui/LobbyUI.js', 'ui/SettingsUI.js', 'ui/ArmoryUI.js', 'ui/MissionsUI.js',
  'ui/DefenseUI.js', 'ui/GrowthUI.js', 'ui/ExchangeUI.js', 'ui/ResearchUI.js',
];
for (const m of SRC_MODULES) {
  const full = `src/${m}`;
  rec(full, pathExists(full) && sizeOk(full, 100), !pathExists(full) ? '缺失' : !sizeOk(full, 100) ? '文件过小' : '');
}

// ============================================================
section('D. Three.js 本地化（vendor/three/）');

const VENDOR_FILES = [
  'vendor/three/three.module.js',
  'vendor/three/loaders/FBXLoader.js',
  'vendor/three/loaders/TGALoader.js',
  'vendor/three/libs/fflate.module.js',
];
for (const f of VENDOR_FILES) {
  rec(f, pathExists(f) && sizeOk(f, 100), !pathExists(f) ? '缺失' : '');
}

// ============================================================
section('E. 游戏资源（public/assets/）');

// FBX 模型（含动画）
const MODELS = [
  'public/assets/models/zombie.fbx',
  'public/assets/models/fps_weapon.fbx',
  'public/assets/models/weapon_arms.fbx',
  'public/assets/models/box_1.fbx', 'public/assets/models/box_2.fbx',
  'public/assets/models/box_3.fbx', 'public/assets/models/box_4.fbx',
  'public/assets/models/anim/z_idle.fbx',
  'public/assets/models/anim/z_walk.fbx',
  'public/assets/models/anim/z_run.fbx',
  'public/assets/models/anim/z_attack.fbx',
  'public/assets/models/anim/z_death.fbx',
];
for (const f of MODELS) {
  const full = join(ROOT, f);
  let s = 0; try { s = statSync(full).size; } catch {}
  const e = existsSync(full);
  rec(`${f} (${(s / 1024).toFixed(0)}KB)`, e && s > 0, e ? '' : '缺失');
}

// WebP 贴图
const TEXTURES = [
  'public/assets/textures/ak74_color.webp',
  'public/assets/textures/arm_color.webp',
  'public/assets/textures/zombie.webp',
];
for (const f of TEXTURES) {
  const full = join(ROOT, f);
  let s = 0; try { s = statSync(full).size; } catch {}
  const e = existsSync(full);
  rec(`${f} (${(s / 1024).toFixed(0)}KB)`, e && s > 0, e ? '' : '缺失');
}

// MP3 音频（数一下数量）
const audioDir = join(ROOT, 'public/assets/audio');
let mp3Count = 0;
try {
  const files = readFileSync(audioDir, { encoding: 'utf-8', flag: 'r' }) ? null : null; // 占位
} catch {}
// 直接 glob 风格列出：用 readdirSync
import { readdirSync } from 'node:fs';
try {
  const mp3s = readdirSync(audioDir).filter((n) => n.endsWith('.mp3'));
  mp3Count = mp3s.length;
  rec(`public/assets/audio/ MP3 文件数 = ${mp3Count}`, mp3Count >= 14, `共 ${mp3s.join(', ')}`);
  // 每个都 > 0
  for (const n of mp3s) {
    const full = join(audioDir, n);
    let s = 0; try { s = statSync(full).size; } catch {}
    rec(`  ${n} (${(s / 1024).toFixed(0)}KB)`, s > 0, s === 0 ? '空文件' : '');
  }
} catch (e) {
  rec('public/assets/audio/ 可访问', false, e.message);
}

// ============================================================
section('F. 源码 import 路径解析');

const EXTS = ['.js', '.mjs'];

/**
 * 从一个文件解析它所有的 import / export from，验证目标路径真实存在。
 * 规则：
 *   - 裸模块名（"three" / "fs"）跳过（由 import map 或 Node 内置处理）
 *   - 相对路径 "./x" / "../x" → 必须能 resolve 到某个 .js 文件或目录入口
 */
function verifyImports(filePath) {
  const rel = filePath; // 相对 ROOT
  const abs = join(ROOT, filePath);
  let src;
  try { src = readFileSync(abs, 'utf-8'); } catch { return []; }

  const issues = [];
  const regex = /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["'](\.{1,2}[^"'`]*)["']|import\(\s*["'](\.{1,2}[^"'`]*)["']\s*\)/g;
  let m;
  while ((m = regex.exec(src)) !== null) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    const fromDir = dirname(abs);
    const target = resolve(fromDir, spec);

    let found = false;
    // 1) 直接有扩展名
    if (existsSync(target)) { found = true; }
    else {
      // 2) 补扩展名
      for (const ext of EXTS) {
        if (existsSync(target + ext)) { found = true; break; }
      }
      // 3) 目录入口
      if (!found) {
        for (const ext of EXTS) {
          if (existsSync(join(target, 'index' + ext))) { found = true; break; }
        }
      }
    }

    if (!found) issues.push(spec);
  }
  return issues;
}

// 扫描 src/ 下所有 .js
function walk(dir, base = dir) {
  const out = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p, base));
      else if (extname(e.name) === '.js') out.push(p);
    }
  } catch {}
  return out;
}

const allSrcJs = walk(join(ROOT, 'src'), join(ROOT, 'src'));
let importFail = 0;
for (const file of allSrcJs) {
  const rel = file.replace(ROOT + sep, '');
  const issues = verifyImports(rel);
  if (issues.length > 0) {
    importFail += issues.length;
    rec(`${rel} import 路径全部可达`, false, `缺失: ${issues.join(', ')}`);
  }
}
if (importFail === 0) {
  rec(`src/ 下 ${allSrcJs.length} 个 .js 文件的全部 import 路径可达`, true);
}

// ============================================================
section('G. index.html 引用可达');

let html;
try { html = readFileSync(join(ROOT, 'index.html'), 'utf-8'); } catch { html = ''; }

// 提取 <script src="..."> 和 <link href="..."> 的相对路径
const refs = [];
const srcRe = /(?:src|href)=["'](\.{0,2}[^"'>]+)["']/g;
let m;
while ((m = srcRe.exec(html)) !== null) {
  const url = m[1];
  if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('data:')) continue;
  refs.push(url);
}
for (const ref of refs) {
  const target = join(ROOT, ref);
  const ok = existsSync(target) && statSync(target).size > 0;
  rec(`index.html → ${ref}`, ok, ok ? '' : '缺失或空文件');
}

// ============================================================
console.log(`\n\x1b[1m============================================================\x1b[0m`);
console.log(`  完整性检查结果：\x1b[32m${pass}\x1b[0m / ${pass + fail} 通过  ${fail ? `\x1b[31m${fail} 失败\x1b[0m` : '\x1b[32m全部通过 ✅\x1b[0m'}`);
console.log(`\x1b[1m============================================================\x1b[0m`);
process.exit(fail ? 1 : 0);
