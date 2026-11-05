# 行动 —— 部署文档

> 纯静态前端项目：无后端、无构建流程、无 npm 依赖。
> 仓库根目录本身就是站点根目录，上传/部署时**不要**再找 `web/` 子目录（旧文档已过时）。

---

## 一、仓库与分支

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/3147ming/xingdong` |
| 分支 | **`master`**（本仓库专属于本游戏） |
| 站点根 | 分支根目录（`index.html` 所在目录） |
| 本地分支 | `master`（直接 `git push origin master`） |

> 旧仓库 `3147ming/ming-games` 与旧 Pages 项目已弃用。

### 推送更新

```bash
git add -A
git commit -m "feat: ..."
git push origin master
```

推送后 Cloudflare Pages 会自动重新部署。

---

## 二、Cloudflare Pages 配置

1. 打开 <https://dash.cloudflare.com> → Workers & Pages → Create → Pages → Connect to Git
2. 选择仓库 `3147ming/xingdong`，授权后：
   - **Production branch**：`master`
   - **Framework preset**：`None`
   - **Build command**：留空
   - **Build output directory**：`/`
3. Save and Deploy
4. 得到形如 `https://xingdong.pages.dev` 的地址，HTTPS 自动开启

`_headers` 文件会被 Cloudflare Pages 自动识别，用于设置缓存策略。

### 自定义域名（可选）
Pages 项目 → Custom domains → 添加域名，CF 会自动签发证书。

---

## 三、GitHub Pages（备选）

仓库 Settings → Pages：
- Source 选 `Deploy from a branch`
- Branch 选 `master`，目录选 `/ (root)`
- 访问 `https://3147ming.github.io/xingdong/`

`.nojekyll` 已存在，GitHub Pages 不会走 Jekyll 处理。

---

## 四、本地开发

```bash
# Windows（Node 已加入 PATH）
node server.mjs 5180
```

浏览器打开 <http://127.0.0.1:5180/>。

> `localhost` / `127.0.0.1` 属于安全上下文，鼠标锁定可直接使用。

### 验证三件套

```bash
node tools/check.mjs          # 静态完整性检查（82 项）
node --test tests/*.test.mjs  # 单元测试（18 项）
node tools/probe.mjs          # 无头浏览器黑盒探针（64 项）
```

---

## 五、为什么必须 HTTPS

浏览器仅在 `https://` 或 `localhost` 下开放 Pointer Lock（鼠标锁定）：

| API | HTTP 公网下的行为 |
|---|---|
| Pointer Lock（鼠标锁定） | ❌ 被禁用，无法瞄准 |
| Web Audio（音效） | ⚠️ 需用户点击后才能播放（项目已处理） |
| WebGL2 | ✅ 一般可用，少数浏览器降级 |

用 HTTP 打开时页面顶部会出现红色提示横幅。

Cloudflare Pages / GitHub Pages 默认都是 HTTPS，无需额外配置。

---

## 六、目录结构（当前）

```
index.html                 入口（import map / HUD / 待机大厅 / 结算）
.nojekyll                   GitHub Pages 标记
_headers                    Cloudflare Pages 缓存策略
server.mjs                  本地静态服务器
DEPLOY.md                   本文档
styles/hud.css              HUD / 大厅 / 准星样式
src/
  main.js                   启动入口
  config/
    weapon.js               武器 / 敌人 / 玩家 / 补给数值
    modes.js                闯关波次 / 无尽曲线 / 平衡上限
  core/
    Game.js                 主控状态机
    AssetManager.js         资源加载
    AudioManager.js         音效
    CollisionWorld.js       AABB 碰撞
    Input.js                键鼠输入
    scoring.js              得分 / 评级
    SaveManager.js          localStorage 存档
  player/                   玩家控制 / 视角 / 血量护甲
  weapons/                  射击 / 换弹 / 后坐力 / 特效
  enemies/                  丧尸 AI / 管理器
  world/                    OutdoorMap（露天地图）/ SupplyManager（补给点）
  ui/                      HUD / Menu / LobbyUI（待机大厅）
vendor/three/               本地化 Three.js（含 FBXLoader）
public/assets/              音频 / 贴图 / 模型（约 10 MB）
tests/                      单元测试
tools/                      check.mjs / probe.mjs
```

---

## 七、浏览器兼容

| 浏览器 | 版本 | 备注 |
|---|---|---|
| Chrome / Edge | 90+ | ✅ 完整支持 |
| Firefox | 88+ | ✅ 完整支持 |
| QQ / 360 浏览器 | 最新版 | ✅ 需切到「极速模式」 |
| Safari | 15+ | ✅ 需 HTTPS |
| IE | — | ❌ 不支持 |

---

## 八、常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 页面 404 | Pages 分支或根目录选错 | 确认分支 = `master`，输出目录 = `/` |
| 资源加载失败 | 漏推 `public/` 或 `vendor/` | 检查分支根目录文件是否完整 |
| 加载卡在某个百分比 | 某资源 404 | F12 → Network 查看具体文件名 |
| 点击开始鼠标没锁定 | 用了 HTTP | 换 HTTPS 地址 |
| 没有声音 | 浏览器自动播放限制 | 点击画布后再操作；检查系统音量 |
| 黑屏 | 不支持 WebGL | 换最新版 Chrome / Edge |
| 更新后仍是旧版 | 缓存 | `Ctrl+F5`；正式发版可给资源文件名加版本号 |
| 存档不保留 | 清了站点数据 / 隐私模式 | localStorage 被清除后无法恢复 |
