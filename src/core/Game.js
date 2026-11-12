/**
 * 游戏主控制器：渲染循环、状态机、模块装配
 * 状态：loading → menu → playing ⇄ paused → result
 *
 * v0.2 改动：
 *  - 接入波次系统，敌人不再无限原地复活；清完三波即胜利结算
 *  - 新增本局统计（击杀 / 爆头 / 命中率 / 用时 / 承受伤害）与 S~C 评级
 *  - 死亡不再"按 R 复活"重开一局，而是进入结算面板，可再来一局或回主菜单
 */
import * as THREE from 'three';
import { WORLD, MATCH, WEAPON, WEAPON_UNLOCKED } from '../config/weapon.js';
import { ENDLESS, DEFENSE, DEFENSE_WAVES, campaignWaves, defenseWave, endlessWave, isDefenseMode, parseMode } from '../config/modes.js';
import { AWAKEN_EVERY, awakenWave } from '../config/awakening.js';
import { MAP_MATERIAL, MATERIALS } from '../config/progression.js';
import { DEFENSE_LEVEL_INDEX, LEVELS } from '../world/levels.js';
import { Input } from './Input.js';
import { AssetManager } from './AssetManager.js';
import { AudioManager } from './AudioManager.js';
import { CollisionWorld } from './CollisionWorld.js';
import { SaveManager } from './SaveManager.js';
import { PerkSystem } from './PerkSystem.js';
import { AwakeningSystem } from './AwakeningSystem.js';
import { PostFX } from './PostFX.js';
import { DayNightSystem } from './DayNightSystem.js';
import { computeAccuracy, computeScore, pickGrade } from './scoring.js';
import { OutdoorMap } from '../world/OutdoorMap.js';
import { LobbyScene } from '../world/LobbyScene.js';
import { RainSystem } from '../world/RainSystem.js';
import { SupplyManager } from '../world/SupplyManager.js';
import { ExplosionSystem } from '../world/ExplosionSystem.js';
import { ThrowSystem } from '../world/ThrowSystem.js';
import { TrapSystem } from '../world/TrapSystem.js';
import { DefenseManager } from '../world/DefenseManager.js';
import { MouseLook } from '../player/MouseLook.js';
import { PlayerController } from '../player/PlayerController.js';
import { WeaponView } from '../weapons/WeaponView.js';
import { GunSystem } from '../weapons/GunSystem.js';
import { Effects } from '../weapons/Effects.js';
import { CasingSystem } from '../weapons/CasingSystem.js';
import { EnemyManager } from '../enemies/EnemyManager.js';
import { HUD } from '../ui/HUD.js';
import { InventoryUI } from '../ui/InventoryUI.js';
import { Menu } from '../ui/Menu.js';
import { SettingsUI } from '../ui/SettingsUI.js';
import { ArmoryUI } from '../ui/ArmoryUI.js';
import { MissionsUI } from '../ui/MissionsUI.js';
import { ExchangeUI } from '../ui/ExchangeUI.js';
import { ResearchUI } from '../ui/ResearchUI.js';
import { DefenseUI } from '../ui/DefenseUI.js';
import { GrowthUI } from '../ui/GrowthUI.js';
import { PerkUI } from '../ui/PerkUI.js';
import { AwakenUI } from '../ui/AwakenUI.js';
import { ThrowUI } from '../ui/ThrowUI.js';
import { MechSystem } from '../player/MechSystem.js';
import { growthTotals } from '../config/growth.js';
import { MISSIONS, missionProgress, FIELD } from '../config/economy.js';

/**
 * 画面质量档位（设置页可切换，参考 3A 游戏的低 / 中 / 高预设）：
 * pixelRatio = 渲染分辨率上限，shadowSize = 阴影贴图分辨率，postfx = 辉光/调色
 */
const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 512, postfx: false },
  medium: { pixelRatio: 1.0, shadows: true, shadowSize: 1024, postfx: true },
  high: { pixelRatio: 1.5, shadows: true, shadowSize: 2048, postfx: true },
};

export class Game {
  constructor() {
    this.state = 'loading';
    this.clock = new THREE.Clock();
    this.accentColor = 0xffb020;
    this._ammoWheelOpen = false;
    this.aiming = false;        // 右键开镜切换状态（toggle，非长按）
    this.runGold = 0;           // 局内金币（闯关 / 无尽波间商店使用，结算清空）
    this._fieldShop = false;    // 当前打开的是否为关卡间商店
    this.perks = new PerkSystem();   // 局内 Roguelike 增益
    this.awakening = new AwakeningSystem(); // 觉醒模式专属增益
    this._perkSlowTimer = 0;         // 子弹时间剩余秒数
    // 连击计数：2.5 秒内连续击杀累积，超时归零
    this._comboCount = 0;
    this._comboTimer = null;
    this._comboLastTime = 0;
    this.stats = this._emptyStats();
  }

  _emptyStats() {
    return {
      kills: 0,
      headshots: 0,
      shots: 0,
      hits: 0,
      damageTaken: 0,
      startedAt: 0,
      endedAt: 0,
      wavesCleared: 0,
    };
  }

  async init() {
    // ---- 环境检测（公网部署适配：WebGL 支持 / HTTPS 鼠标锁定提示）----
    if (!this._checkWebGL()) return;
    this._checkProtocol();

    // ---- 渲染器 ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 色调映射在 PostFX 合成阶段统一做（渲染到 RT 时 Three.js 不会自动应用），
    // 这里仍设成 ACES，是为了让「武器独立视图」直接画到屏幕时走同一条曲线。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // 软阴影：PCSS（阻塞物搜索 + 可变半影），比固定半径 PCF 有接触硬化
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 软件渲染（无头 / 无 GPU）：跳过 PCSS 与 SSAO，避免驱动崩溃与超低帧率
    this._softwareGL = this._detectSoftwareGL();
    if (!this._softwareGL) this._enablePCSS();
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(WORLD.fogColor);
    this.scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);

    // 程序化环境贴图（PMREM）：PBR 金属材质没有环境反射时会渲染成纯黑，
    // 这里用"摄影棚"式亮面给枪械金属提供反射与柔和补光
    this._buildEnvironmentMap();

    // 基础环境光：避免背光面/武器模型渲染成纯黑影
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(ambient);
    // 主平行光：投射阴影，给模型带来体积感与立体感
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(20, 40, 15);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -40;
    dirLight.shadow.camera.right = 40;
    dirLight.shadow.camera.top = 40;
    dirLight.shadow.camera.bottom = -40;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 120;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    dirLight.shadow.radius = 4;    // PCSS 的阻塞物搜索半径（像素）
    this.scene.add(dirLight);

    // 昼夜/天气系统：保留 const 声明不变，另外存实例引用供 update 动态调参
    this._dnSun = dirLight;
    this._dnAmbient = ambient;
    this._dnState = {
      time: 0.40,
      dayLength: 240,
      weather: 'clear',
      nextWeatherAt: 45,
      fogNear0: WORLD.fogNear,
      fogFar0: WORLD.fogFar,
    };
    this.dayNight = new DayNightSystem({
      state: this._dnState,
      sun: this._dnSun,
      amb: this._dnAmbient,
      fog: this.scene.fog,
      bg: this.scene.background,
    });

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.03, 200);
    this.scene.add(this.camera);
    // 武器独立视图相机：与主相机共用位置/朝向与 fov，但独立渲染、独立近裁面，
    // 绘制前清一次深度 → 枪身永远不会插进墙里。
    this.viewCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 8);

    // 降雨系统：跟随相机的 GPU 雨幕，由天气系统切换
    this.rain = new RainSystem(this.scene);

    // 轻量后期处理：SSAO + Bloom 辉光 + 暗角 + 受击边缘闪红 + ACES 合成
    this.postfx = new PostFX(this.renderer);
    // 软件渲染 / ?nofx=1：关闭 SSAO（性能与稳定性优先，其余后期保留）
    if (this._softwareGL || new URLSearchParams(location.search).has('nofx')) {
      this.postfx.aoEnabled = false;
    }
    this._lastVital = null;
    // 动态分辨率：按帧时间自动缩放绘制缓冲（?dynres=0 可关闭）
    this._dynRes = {
      enabled: !new URLSearchParams(location.search).has('dynres'),
      scale: 1,
      max: 1,
      acc: 0,
      n: 0,
      settle: 3.0,
    };

    // ---- 加载资源 ----
    this.menu = new Menu({
      onStart: () => this.startGame(this.menu.lobby.mode),
      onResume: () => this.resumeGame(),
      onRestart: () => this.restart(),
      onMenu: () => this.backToMenu(),
      onNextLevel: () => this.nextLevel(),
      onCloseLobby: () => this.closeLobbyPanel(),
    });

    // 局外存档：大厅资源与战绩从这里读
    this.save = new SaveManager();
    this._refreshLobby();

    // ---- 模式与关卡（?mode=endless / ?level=N）----
    this.queryParams = new URLSearchParams(location.search);
    this.mode = parseMode(this.queryParams.get('mode'));
    const levelParam = Number(this.queryParams.get('level'));
    this.levelIndex = Number.isFinite(levelParam) && levelParam >= 1 ? Math.floor(levelParam) - 1 : 0;
    this.menu.lobby.setMode(this.mode);

    this.assets = await new AssetManager().loadAll((p) => this.menu.setLoading(p));

    this.menu.setLoading(100, '正在初始化音频…');
    this.audio = new AudioManager();
    await this.audio.init();

    // ---- 世界与玩家 ----
    this.collision = new CollisionWorld();
    this.map = new OutdoorMap(this.scene, this.collision, this.assets, this._mapIndexForMode(this.mode)).build();

    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = (locked) => this._onLockChange(locked);

    this.mouseLook = new MouseLook(this.camera);
    // 设置面板：灵敏度 / 音量 / 键位（存档持久化，改动立即生效）
    this.settings = new SettingsUI({
      save: this.save,
      onChange: () => this._applySettings(),
    });
    this._applySettings();
    this.player = new PlayerController(this.camera, this.input, this.collision, this.audio, this.map.playerSpawn);

    this.hud = new HUD();
    // 行囊：满员拾取的补给自动存入，B 打开使用
    this.inventory = new InventoryUI({
      onUse: (type) => this._useInventoryItem(type),
      onClose: () => this._closeInventory(),
    });
    // 波间三选一强化卡片（DOM 覆盖层 + 右侧已选图标）
    this.perkUI = new PerkUI({
      onPick: (id) => this._pickPerk(id),
      onSkip: () => this._skipPerk(),
    });
    this.awakenUI = new AwakenUI({
      onPick: (id) => this._pickAwaken(id),
      onSkip: () => this._skipAwaken(),
    });
    this.effects = new Effects(this.scene);
    this.casings = new CasingSystem(this.scene, this.audio);
    this.weaponView = new WeaponView(this.camera, this.assets, this.viewCamera);
    this.weaponView.setEnvironment(this.scene.environment);

    this.enemies = new EnemyManager({
      scene: this.scene,
      assets: this.assets,
      collision: this.collision,
      audio: this.audio,
      player: this.player,
      effects: this.effects,
      hud: this.hud,
      spawnPoints: this.map.spawnPoints,
      patrolPoints: this.map.waypoints,
      mode: this.mode,
      infinite: this.mode === 'endless' || this.mode === 'defense_endless',
      waveGen: this.mode === 'endless' ? endlessWave : (this.mode === 'defense_endless' ? defenseWave : null),
      waves: this._wavesForMode(this.mode),
      breakTime: isDefenseMode(this.mode) ? DEFENSE.breakSec : undefined,
      spawnGap: isDefenseMode(this.mode) ? DEFENSE.spawnGap : undefined,
      // 实例池按无尽同屏上限预建，保证大厅切模式后无需重建对象池
      poolSize: Math.max(ENDLESS.maxAlive, DEFENSE.maxAlive),
      onKill: () => this._onKill(),
      onDeath: (enemy) => this._onEnemyDeath(enemy),
      onWaveStart: (i, total) => this._onWaveStart(i, total),
      onWaveClear: (i, isLast) => this._onWaveClear(i, isLast),
      onVictory: () => this._onVictory(),
      onPlayerHit: (dmg) => { this.stats.damageTaken += dmg; },
    });

    // 场景可爆炸物：油桶 / 汽车被子弹点燃后 2 秒爆炸，可连锁引爆
    this.explosions = new ExplosionSystem({
      scene: this.scene,
      collision: this.collision,
      audio: this.audio,
      player: this.player,
      enemies: this.enemies,
      effects: this.effects,
    });
    this.explosions.setExplodables(this.map.explodables);

    this.gun = new GunSystem({
      camera: this.camera,
      player: this.player,
      mouseLook: this.mouseLook,
      weaponView: this.weaponView,
      effects: this.effects,
      casings: this.casings,
      audio: this.audio,
      collision: this.collision,
      enemies: this.enemies,
      hud: this.hud,
      explosions: this.explosions,
      onKill: () => {},
      onShot: (info) => this._onShot(info),
    });

    // 投掷物：手雷 / 燃烧瓶（按 G / H 进入投掷态，按住左键蓄力）
    this.throwSystem = new ThrowSystem({
      scene: this.scene,
      collision: this.collision,
      camera: this.camera,
      player: this.player,
      enemies: this.enemies,
      effects: this.effects,
      audio: this.audio,
      explosions: this.explosions,
    });
    this.throwUI = new ThrowUI();

    // 陷阱与炮塔：波间商店购买蓝图 → 按 F 放置
    this.trapSystem = new TrapSystem({
      scene: this.scene,
      collision: this.collision,
      camera: this.camera,
      player: this.player,
      enemies: this.enemies,
      effects: this.effects,
      audio: this.audio,
      explosions: this.explosions,
      hud: this.hud,
    });

    // 补给点系统（弹药 / 医疗 / 护甲 / 综合物资）
    this.supplies = new SupplyManager({
      scene: this.scene,
      player: this.player,
      gun: this.gun,
      playerHealth: this.player.health,
      hud: this.hud,
      audio: this.audio,
      inventory: this.inventory,
      onThrowable: () => {
        const kind = this.throwSystem.grantCache();
        this.hud.showSupplyToast('获得投掷物', kind === 'frag' ? '手雷 +1' : '燃烧瓶 +1');
      },
    });
    this.supplies.setAutoPickup(this.save.data.settings.autoPickup);
    this.supplies.setPoints(this.map.level.supplyPoints);
    // 敌人死亡掉落：在 SupplyManager 构造好后回填给 EnemyManager
    this.enemies.supply = this.supplies;

    // 守城模式：HUD / 波间商店 / 核心与场景武器
    this.defenseUI = new DefenseUI({
      onBuy: (id) => this._buyShopItem(id),
      onContinue: () => this._closeShop(),
    });
    this._setupDefense();

    // 机甲：局内 TAB 面板召唤；形态增益由 MechSystem 统一管理
    this.mech = new MechSystem({
      scene: this.scene,
      player: this.player,
      gun: this.gun,
      enemies: this.enemies,
      effects: this.effects,
      audio: this.audio,
      hud: this.hud,
      save: this.save,
    });
    // 局内成长面板：机甲 / 天赋 / 觉醒
    this.growthUI = new GrowthUI({
      onClose: () => this._closeGrowthPanel(),
      onUnlockMech: (id) => {
        const res = this.save.unlockMech(id);
        this._refreshLobby();
        if (!res.ok) this.hud.showSupplyToast('机甲解锁失败', res.message);
        else this.hud.showSupplyToast('机甲已解锁', res.message);
        return res;
      },
      onActivateMech: (id) => {
        const res = this.mech.activate(id);
        this.growthUI.setMechStates(this.mech.getStates());
        this.growthUI.render();
        this.hud.showSupplyToast(res.ok ? '机甲' : '机甲无法启动', res.message);
        if (res.ok) this._closeGrowthPanel();
        return res;
      },
      onUpgradeTalent: (branch) => {
        const res = this.save.upgradeTalent(branch);
        this._applyGrowth();
        this._refreshLobby();
        if (!res.ok) this.hud.showSupplyToast('天赋升级失败', res.message);
        return res;
      },
      onAllocate: (stat) => {
        this.save.allocateAttr(stat);
        this._applyGrowth();
        this._refreshLobby();
      },
    });
    // 大厅成长页：机甲解锁 / 天赋升级 / 属性点分配
    this.menu.lobby.bindGrowth({
      save: this.save,
      onUnlockMech: (id) => this.save.unlockMech(id),
      onUpgradeTalent: (branch) => this.save.upgradeTalent(branch),
      onAllocate: (stat) => this.save.allocateAttr(stat),
    });

    // 大厅改装：把存档里的配件合成为实际武器数据
    this.gun.applyLoadout(this.save.data.loadout);
    this.armory = new ArmoryUI({
      save: this.save,
      onChange: () => this.gun.applyLoadout(this.save.data.loadout),
    });
    this.missions = new MissionsUI({
      save: this.save,
      onChange: () => this._refreshLobby(),
    });
    this.exchange = new ExchangeUI({
      save: this.save,
      onChange: () => this._refreshLobby(),
    });
    this.research = new ResearchUI({
      save: this.save,
      onChange: () => this._refreshLobby(),
    });

    // 初始数值同步
    this.hud.reset();
    this.hud.setKills(0);
    this.hud.setEnemies(0);
    this.hud.setWave(1, this.enemies.infinite ? null : this.enemies.waves.length, 0);

    // 第三轮：开局操作提示（3 秒后自动淡出）+ FPS 面板
    this.tipsEl = document.getElementById('tips');
    this.waveBannerEl = document.getElementById('wave-banner');
    this.fpsPanel = document.getElementById('fps-panel');
    this.fpsValue = document.getElementById('fps-value');
    this._fpsFrames = 0;
    this._fpsAcc = 0;
    this._fpsVisible = new URLSearchParams(location.search).has('debug');
    if (this._fpsVisible && this.fpsPanel) this.fpsPanel.classList.remove('hidden');

    // 让相机在菜单界面就处于正确位置
    this.player.update(0.016, this.mouseLook);
    this.mouseLook.update(0.016);

    // 相机点击：游戏中 / 大厅重新锁定鼠标
    this.renderer.domElement.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
      else if (this.state === 'lobby' && !this.input.locked) this.input.requestLock();
    });

    window.addEventListener('resize', () => this._onResize());

    // 调试信息（访问 index.html?debug=1 时显示）
    if (new URLSearchParams(location.search).has('debug')) {
      this.debugEl = document.createElement('div');
      this.debugEl.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:12px', 'z-index:99',
        'font:12px/1.5 Consolas,monospace', 'color:#9fe8ff',
        'background:rgba(0,0,0,0.68)', 'padding:8px 10px', 'white-space:pre',
        'pointer-events:none', 'border:1px solid rgba(120,200,255,0.4)',
      ].join(';');
      document.body.appendChild(this.debugEl);
      this._debugTimer = 0;
    }

    // 大厅 3D：可第一人称漫游的基地空间（独立场景，仅大厅 / 面板态渲染）
    this.lobby = new LobbyScene();
    // 复用战斗场景的 PMREM 环境贴图，让大厅里的金属/玻璃也有反射细节
    if (this.scene.environment) this.lobby.scene.environment = this.scene.environment;
    this.lobbyHud = document.getElementById('lobby-hud');
    this.lobbyEntry = document.getElementById('lobby-entry');
    this.lobbyInteract = document.getElementById('lobby-interact');
    this.lobbyInteractName = document.getElementById('lobby-interact-name');
    if (this.lobbyEntry) {
      this.lobbyEntry.addEventListener('click', () => this._enterLobbyFromEntry());
    }
    // 注意：指针锁定失败（无手势 / 浏览器拒绝）时不再弹全屏遮罩，
    // 只保留底部「点击画面继续」提示，避免已点过进场的玩家又被遮罩挡住。

    // 首次进入大厅：需要一次点击手势才能锁定鼠标
    this.enterLobby(true);
    this.menu.lobby.onEnterTesting = () => this.startGame('testing');

    // 启动循环
    this.clock.start();
    this.renderer.setAnimationLoop(() => this._loop());

    // 浏览器锁定：失焦 / 切标签页时自动暂停，避免后台被丧尸围殴
    window.addEventListener('blur', () => {
      if (this.state === 'playing' && performance.now() > (this._ignoreBlurUntil || 0)) {
        this.pauseGame();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pauseGame();
    });
  }

  /** 进入全屏（必须在用户手势回调中调用；失败时静默降级） */
  _enterFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    try {
      const p = el.requestFullscreen({ navigationUI: 'hide' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 浏览器拒绝时保持窗口模式 */ }
  }

  /** 退出全屏（回大厅时调用） */
  _exitFullscreen() {
    if (!document.fullscreenElement || !document.exitFullscreen) return;
    try {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // ---------------- 状态切换 ----------------
  /** @param {'campaign'|'endless'|'testing'} [mode] 大厅选择的作战模式 */
  startGame(mode) {
    if (mode && mode !== this.mode) this._applyMode(mode);
    if (mode === 'testing') {
      // 测试房：加载地图，不开始战斗、不刷怪、不重置生命，供枪械手感测试
      this.state = 'playing';
      this.hud.setVisible(true);
      this.menu.hideAll();
      this.menu.hideLobbyPanel();
      if (this.lobbyHud) this.lobbyHud.classList.add('hidden');
      this._hideLobbyEntry();
      this.input.enabled = true;
      this.mouseLook.reset();
      this.input.consumeMouseDelta();
      this._enterFullscreen();
      this._ignoreBlurUntil = performance.now() + 800;
      this.input.requestLock();
      this.gun.applyLoadout(this.save.data.loadout);
      this.player.respawn(this.map.playerSpawn);
      this.player.health.reset();
      this._showTips();
      return;
    }
    this.audio.resume();
    this.audio.setSpace?.('outdoor');
    this.audio.startBattleMusic();
    this.audio.startAmbience();
    this.state = 'playing';
    this.stats = this._emptyStats();
    this.stats.startedAt = performance.now();
    this.stats.wavesCleared = 0;

    // 局内战地金币：每局从 0 开始，结算清空；守城用核心面板的金币行
    this.runGold = 0;
    if (this.inventory) this.inventory.reset();
    this._fieldShop = false;
    this.defenseUI.setRunGold(0);
    this.defenseUI.setRunGoldVisible(!this.defense);

    this.hud.setVisible(true);
    this.hud.reset(this.enemies.infinite ? null : this.enemies.waves.length);
    this.hud.setKills(0);
    this.menu.hideAll();
    this.menu.hideLobbyPanel();
    if (this.lobbyHud) this.lobbyHud.classList.add('hidden');
    this._hideLobbyEntry();
    if (this.defenseUI) {
      this.defenseUI.setActive(!!this.defense);
      this.defenseUI.hideShop();
    }
    this.input.enabled = true;
    this.mouseLook.reset();
    this.input.consumeMouseDelta();
    this._enterFullscreen();
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
    // 应用大厅最新改装后再补满弹药
    this.gun.applyLoadout(this.save.data.loadout);
    if (isDefenseMode(this.mode)) {
      // 守城模式弹药免费
      this.gun.resetAmmo();
    } else {
      // 闯关 / 无尽：带入局外购买的备弹（弹匣免费装满）
      this.gun.applyAmmoStock(this.save.data.meta.ammoStock, this.save.researchTotals().ammoCapMul);
    }
    // 应用局外成长（属性点 / 天赋）后再复活，生命上限才是最新值
    this.perks.reset();
    this.perkUI.reset();
    this.awakening.reset();
    this.awakenUI.reset();
    this._perkSlowTimer = 0;
    // 重置连击
    this._comboCount = 0;
    clearTimeout(this._comboTimer);
    this._comboTimer = null;
    this._comboLastTime = 0;
    this._applyGrowth();
    this.mech?.reset();
    this.player.respawn(this.map.playerSpawn);
    this.player.health.reset();
    this.enemies.startMatch();
    this.supplies.reset();
    this.explosions.reset();
    this.throwSystem.reset();
    this.trapSystem.reset();
    this._lastVital = null;
    if (this.defense) this.defense.resetRun();
    this._showTips();
    this._updateMissionObjective();
  }

  // ---------------- 模式 / 地图 ----------------
  /** 当前模式对应的地图索引（守城固定用领地防线，测试房用主图） */
  _mapIndexForMode(mode) {
    if (isDefenseMode(mode)) return DEFENSE_LEVEL_INDEX;
    if (mode === 'testing') return 0;
    return mode === 'campaign' ? this.levelIndex : 0;
  }

  /** 当前模式的波次表 */
  _wavesForMode(mode) {
    if (isDefenseMode(mode)) return DEFENSE_WAVES.slice();
    if (mode === 'endless') return [endlessWave(1)];
    if (mode === 'awakening') return [awakenWave(1)];
    // 闯关：关卡越高，丧尸血量 / 伤害 / 速度按关卡系数成长
    return campaignWaves(this.levelIndex);
  }

  /**
   * 切换地图：销毁旧场景 → 清碰撞 → 重建新图 → 迁移玩家与敌人导航。
   * 守城地图额外创建核心 / 场景武器。
   */
  _loadMap(index) {
    this.mech?.reset();
    if (this.defense) {
      this.defense.dispose();
      this.defense = null;
    }
    if (this.map && this.map.builder) this.map.builder.dispose();
    this.collision.clear();
    this.map = new OutdoorMap(this.scene, this.collision, this.assets, index).build();

    this.enemies.setNavigation(this.map.spawnPoints, this.map.waypoints);
    this.supplies.setPoints(this.map.level.supplyPoints);
    this.explosions?.setExplodables(this.map.explodables);
    this.trapSystem?.reset();
    this.player.respawn(this.map.playerSpawn);
    this.mouseLook.yaw = this.map.level.startYaw != null ? this.map.level.startYaw : 0;
    this.mouseLook.pitch = 0;
    this._setupDefense();
  }

  /** 按当前地图创建守城运行时（非守城图则保持为空） */
  _setupDefense() {
    const def = this.map && this.map.level ? this.map.level.defense : null;
    this.defense = def ? new DefenseManager({
      scene: this.scene,
      collision: this.collision,
      player: this.player,
      camera: this.camera,
      enemies: this.enemies,
      gun: this.gun,
      weaponView: this.weaponView,
      effects: this.effects,
      audio: this.audio,
      hud: this.hud,
      save: this.save,
      map: this.map,
      onCoreDestroyed: () => this._onCoreDestroyed(),
    }) : null;
    if (this.defense) this.defense.setUI(this.defenseUI);
    if (this.defenseUI) {
      this.defenseUI.setActive(!!this.defense);
      // 守城用核心面板自带的金币行；其余模式显示独立战地金币条
      this.defenseUI.setRunGoldVisible(!this.defense);
    }
    if (this.defense) this.defense.resetRun();
  }

  /** 切换模式：地图、波次规则、守城运行时全部同步 */
  _applyMode(mode) {
    const mapChanged = this._mapIndexForMode(mode) !== this._mapIndexForMode(this.mode);
    this.mode = mode;
    if (mapChanged) this._loadMap(this._mapIndexForMode(mode));

    const defense = isDefenseMode(mode);
    if (mode !== 'testing') {
      this.enemies.applyMode({
        mode,
        infinite: mode === 'endless' || mode === 'defense_endless' || mode === 'awakening',
        waveGen: mode === 'endless' ? endlessWave : (mode === 'defense_endless' ? defenseWave : (mode === 'awakening' ? awakenWave : null)),
        waves: this._wavesForMode(mode),
        breakTime: defense ? DEFENSE.breakSec : MATCH.breakTime,
        spawnGap: defense ? DEFENSE.spawnGap : MATCH.spawnGap,
      });
    }
    if (!mapChanged) {
      // 从守城切回普通模式时，把守城对象与 HUD 收起
      if (this.defense && !defense) {
        this.defense.dispose();
        this.defense = null;
      }
      if (this.defenseUI) this.defenseUI.setActive(!!this.defense);
      if (this.defenseUI) this.defenseUI.setRunGoldVisible(!this.defense);
    }
    this.menu.lobby.setMode(mode);
  }



  /** 第三轮：显示开局操作提示，3 秒后淡出 */
  _showTips() {
    if (!this.tipsEl) return;
    this.tipsEl.classList.remove('hide');
    clearTimeout(this._tipsTimer);
    this._tipsTimer = setTimeout(() => this.tipsEl.classList.add('hide'), 3000);
  }

  /** 第三轮：切换 FPS 面板显示 */
  _toggleFps() {
    this._fpsVisible = !this._fpsVisible;
    if (this.fpsPanel) this.fpsPanel.classList.toggle('hidden', !this._fpsVisible);
  }

  pauseGame() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.throwSystem.cancel();
    this._pauseGuard = 0.35;   // 防止 Esc 解锁指针时被同一帧立刻"继续"
    if (this._ammoWheelOpen) {
      this._ammoWheelOpen = false;
      this.gun.closeAmmoWheel();
    }
    this.input.enabled = false;
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    this.aiming = false;
    this.menu.showPause();
  }

  resumeGame() {
    if (this.state !== 'paused') return;
    this.audio.resume();
    this.state = 'playing';
    this.input.enabled = true;
    this.menu.hideAll();
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
  }

  /** 暂停面板"重新开始" / 结算面板"再来一局" */
  restart() {
    this.perks.reset();
    this.perkUI.reset();
    this.awakening.reset();
    this.awakenUI.reset();
    this._perkSlowTimer = 0;
    // 重置连击
    this._comboCount = 0;
    clearTimeout(this._comboTimer);
    this._comboTimer = null;
    this._comboLastTime = 0;
    this._applyGrowth();
    this.mech?.reset();
    this.player.respawn(this.map.playerSpawn);
    this.player.health.reset();
    this.mouseLook.reset();
    if (isDefenseMode(this.mode)) this.gun.resetAmmo();
    else this.gun.applyAmmoStock(this.save.data.meta.ammoStock, this.save.researchTotals().ammoCapMul);
    this.stats = this._emptyStats();
    this.stats.startedAt = performance.now();
    this.runGold = 0;
    this._fieldShop = false;
    if (this.defenseUI) {
      this.defenseUI.setRunGold(0);
      this.defenseUI.setRunGoldVisible(!this.defense);
    }
    this.enemies.startMatch();
    this.supplies.reset();
    this.explosions.reset();
    this.throwSystem.reset();
    this.trapSystem.reset();
    if (this.defense) this.defense.resetRun();
    if (this.defenseUI) {
      this.defenseUI.setActive(!!this.defense);
      this.defenseUI.hideShop();
    }
    this.hud.setKills(0);
    this.hud.reset(this.enemies.infinite ? null : this.enemies.waves.length);
    this.hud.setVisible(true);
    this.menu.hideAll();
    this.state = 'playing';
    this.input.enabled = true;
    this.audio.resume();
    this._enterFullscreen();
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
    this._showTips();
    this._updateMissionObjective();
  }

  /**
   * 结算面板"返回主菜单" / 暂停面板"退出"：统一回到 3D 大厅
   */
  backToMenu() {
    if (this.state === 'result') this.stats.endedAt = performance.now();
    else this._persistAmmoStock();
    this.enterLobby(false);
  }

  /**
   * 进入 3D 大厅
   * @param {boolean} firstEntry 首次加载完成：没有用户手势，需要点击遮罩才能锁定鼠标
   */
  enterLobby(firstEntry = false) {
    this.state = 'lobby';
    this.perkUI.reset();
    this.throwSystem.cancel();
    this.audio.stopAmbience();
    this.audio.setSpace?.('shed');
    this.audio.startLobbyMusic();
    this.input.enabled = true;
    this.input.releaseLock();
    this._exitFullscreen();
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    this.hud.setVisible(false);
    if (this.defenseUI) {
      this.defenseUI.setActive(false);
      this.defenseUI.hideShop();
      this.defenseUI.setRunGoldVisible(false);
    }
    this._fieldShop = false;
    if (this.growthUI) this.growthUI.hide();
    this.mech?.reset();
    if (this.lobby) this.lobby.resetPlayer();
    this._refreshLobby();
    this.menu.showStart();
    this.menu.hideLobbyPanel();
    if (this.lobbyHud) this.lobbyHud.classList.remove('hidden');
    if (this.lobbyInteract) this.lobbyInteract.classList.add('hidden');
    this._syncLobbyHud();
    this._ignoreBlurUntil = performance.now() + 800;

    if (firstEntry) {
      this._showLobbyEntry();
    } else {
      this._hideLobbyEntry();
      this.input.requestLock();
    }
  }

  _showLobbyEntry() {
    if (this.lobbyEntry) this.lobbyEntry.classList.remove('hidden');
  }

  _hideLobbyEntry() {
    if (this.lobbyEntry) this.lobbyEntry.classList.add('hidden');
  }

  /** 点击「进入基地大厅」：手势内请求指针锁定 */
  _enterLobbyFromEntry() {
    if (this.state !== 'lobby') return;
    this._hideLobbyEntry();
    this.input.enabled = true;
    this.input.requestLock();
    this.audio?.resume();
  }

  /**
   * 打开大厅面板（TAB = 上次页签；F = 设施对应页签）
   * @param {string} tab
   */
  openLobbyPanel(tab) {
    if (this.state !== 'lobby') return;
    this.state = 'lobby_panel';
    this._hideLobbyEntry();
    this.input.releaseLock();
    this.input.enabled = false;      // 面板用系统鼠标，停止采集视角位移
    this.input.consumeMouseDelta();
    this.menu.showLobbyPanel(tab || 'battle');
    this._syncLobbyHud();
    if (this.lobbyHud) this.lobbyHud.classList.add('hidden');
    if (this.lobbyInteract) this.lobbyInteract.classList.add('hidden');
  }

  /** 关闭大厅面板，回到 3D 漫游 */
  closeLobbyPanel() {
    if (this.state !== 'lobby_panel') return;
    this.state = 'lobby';
    this.input.enabled = true;
    this.menu.hideLobbyPanel();
    this._blurUiFocus();
    if (this.lobbyHud) this.lobbyHud.classList.remove('hidden');
    this.input.requestLock();
  }

  /** 清掉面板按钮的焦点，避免按键继续落到隐藏的 UI 上 */
  _blurUiFocus() {
    const el = document.activeElement;
    if (el && el !== document.body && el.blur) el.blur();
  }

  /** 把存档资源同步到 3D 大厅顶部资源条 */
  _syncLobbyHud() {
    if (!this.save) return;
    const m = this.save.data.meta;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    set('lh-cores', m.cores || 0);
    set('lh-coins', m.coins || 0);
    set('lh-rep', m.reputation || 0);
  }

  /** 大厅设施交互提示（F 打开 xxx） */
  _updateLobbyInteract(nearest) {
    if (!this.lobbyInteract) return;
    if (!nearest) {
      this.lobbyInteract.classList.add('hidden');
      return;
    }
    this.lobbyInteract.classList.remove('hidden');
    if (this.lobbyInteractName) this.lobbyInteractName.textContent = `打开 ${nearest.def.name}`;
  }

  /** 把存档数据刷到大厅面板 */
  _refreshLobby() {
    if (!this.save || !this.menu || !this.menu.lobby) return;
    const d = this.save.data;
    this.menu.lobby.setResources(d.meta.cores, d.meta.coins || 0, d.meta.reputation || 0);
    this.missions?.refresh();
    this.exchange?.refresh();
    this.research?.refresh();
    this.armory?.refresh();
    this.menu.lobby.renderGrowth();
    this.menu.lobby.setStats({
      runs: d.stats.runs,
      kills: d.stats.kills,
      level: d.stats.bestLevel,
      wave: d.stats.bestWave,
    });
    this._syncLobbyHud();
  }

  /** 应用设置（改键 / 灵敏度 / 音量 / 自动拾取），改动后立即生效 */
  _applySettings() {
    const s = this.save.data.settings;
    if (this.input) this.input.setBindings(s.binds);
    if (this.audio) this.audio.setMasterVolume(s.vol);
    if (this.mouseLook && Number.isFinite(s.sens)) this.mouseLook.sensitivity = s.sens;
    if (this.supplies) this.supplies.setAutoPickup(s.autoPickup);

    // 画面质量：分辨率 / 阴影 / 辉光即时生效；软件渲染固定走最低档保证可测性
    const q = this._softwareGL ? QUALITY.low : (QUALITY[s.quality] || QUALITY.high);
    this._quality = q;
    if (this.renderer) {
      this.renderer.shadowMap.enabled = q.shadows;
      if (this._dnSun) {
        this._dnSun.castShadow = q.shadows;
        if (this._dnSun.shadow.mapSize.x !== q.shadowSize) {
          this._dnSun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
          if (this._dnSun.shadow.map) {
            this._dnSun.shadow.map.dispose();
            this._dnSun.shadow.map = null;   // 让渲染器按新分辨率重建阴影贴图
          }
        }
      }
      if (this.postfx) this.postfx.enabled = q.postfx;
      // 分辨率与 PostFX 目标尺寸统一由动态分辨率入口处理
      this._applyRenderScale();
    }
  }

  /** P 键：切换自动拾取 */
  _toggleAutoPickup() {
    const on = !this.save.data.settings.autoPickup;
    this.save.setSetting('autoPickup', on);
    if (this.supplies) this.supplies.setAutoPickup(on);
    this.hud.showSupplyToast(on ? '自动拾取：开启' : '自动拾取：关闭',
      on ? '靠近补给箱自动拾取' : '按 F 手动拾取');
  }

  /** 应用局外成长（属性点 + 天赋 + 科研 + 局内 perk + 觉醒）到玩家与枪械 */
  _applyGrowth() {
    const t = growthTotals(this.save.data);
    const r = this.save.researchTotals();
    const p = this.perks.mods;
    const a = this.mode === 'awakening' ? this.awakening.buildMods() : {};
    // 合并 perk + 觉醒（同类字段累加）
    const hpAdd = (p.hpAdd || 0) + (a.hpAdd || 0);
    const armorAdd = (p.armorAdd || 0) + (a.armorAdd || 0);
    const dmgAdd = (p.dmgAdd || 0) + (a.dmgAdd || 0);
    const fireRateAdd = (p.fireRateAdd || 0) + (a.fireRateAdd || 0);
    const speedAdd = (p.speedAdd || 0) + (a.speedAdd || 0);
    const slowResist = Math.min(1, (p.slowResist || 0) + (a.slowResist || 0));
    const critAdd = (p.critAdd || 0) + (a.critAdd || 0);
    // critMul 取最高
    const critMul = Math.max(p.critMul || 1.6, a.critMul || 1.6);
    // reloadCut（觉醒专属）
    const reloadCut = (a.reloadCut || 0);
    this.player.health.setBonus(
      t.maxHpBonus + r.hpBonus + hpAdd,
      t.maxArmorBonus + r.armorBonus + armorAdd
    );
    this.player.speedMul = t.speedMul * (1 + speedAdd);
    this.player.hitSlowResist = slowResist;
    this.gun.damageMul = t.dmgMul * r.dmgMul * (1 + dmgAdd);
    this.gun.fireRateMul = t.fireRateMul * (1 + fireRateAdd);
    // 科研：换弹变快、暴击、爆头与首领伤害
    this.gun.reloadMul = Math.max(0.45, t.reloadMul - r.reloadCut - reloadCut);
    this.gun.critChance = Math.min(1, r.critChance + critAdd);
    this.gun.critMul = critAdd > 0 ? critMul : 1.6;
    this.gun.headshotMulBonus = r.headshotMul;
    this.gun.bossMul = r.bossMul;
    // perk：弹匣容量 / 穿透 / 双重射击 / 爆裂 / 弹射（合并觉醒）
    const mergedMods = {
      ...p,
      pierceAdd: (p.pierceAdd || 0) + (a.pierceAdd || 0),
      explodeRadius: Math.max(p.explodeRadius || 0, a.explodeRadius || 0),
      explodeDamage: (p.explodeDamage || 0) + (a.explodeDamage || 0),
      extraPellets: (p.extraPellets || 0) + (a.extraPellets || 0),
      bounceAdd: (p.bounceAdd || 0) + (a.bounceAdd || 0),
      slowMoAdd: (p.slowMoAdd || 0) + (a.slowMoAdd || 0),
    };
    this.gun.applyPerkMods(mergedMods);
    if (this.supplies) this.supplies.dropChanceMul = r.dropChanceMul;
  }

  // ---------------- 成长面板（TAB：机甲 / 天赋 / 觉醒） ----------------
  _openGrowthPanel() {
    if (!this.growthUI || this.state !== 'playing') return;
    this.state = 'panel';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    if (this._ammoWheelOpen) {
      this._ammoWheelOpen = false;
      this.gun.closeAmmoWheel();
    }
    this.growthUI.show(this.save, this.mech.getStates());
  }

  _closeGrowthPanel() {
    if (this.state !== 'panel') return;
    this.growthUI.hide();
    this.state = 'playing';
    this.input.enabled = true;
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
  }

  /** 尚未开放的功能：给一个轻提示，避免按键"没反应" */
  _featureSoon(label, hint) {
    this.hud.showSupplyToast(label, hint);
  }

  /** G / H：切换手雷 / 燃烧瓶投掷态 */
  _toggleThrow(kind) {
    const res = this.throwSystem.toggleMode(kind);
    if (!res.ok) {
      this.hud.showSupplyToast('投掷物不足', res.message);
      return;
    }
    this.hud.showSupplyToast(res.mode ? '投掷准备' : '取消投掷', res.message);
  }

  /** 指针锁定状态变化 */
  _onLockChange(locked) {
    if (!locked && this.state === 'playing') this.pauseGame();
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    if (this.lobby) this.lobby.resize();
    // 动态分辨率重置回满档，交给 _tickDynamicResolution 重新收敛
    if (this._dynRes) { this._dynRes.scale = 1; this._dynRes.settle = 1.5; }
    this._applyRenderScale();
  }

  // ---------------- 波次 / 结算 ----------------
  /**
   * 击杀以「敌人死亡事件」为准，而不是以「最后一发子弹」为准。
   * 这样以后加爆炸物 / 环境击杀，统计也不会漏。
   */
  _onKill() {
    this.stats.kills += 1;
    // Perk「嗜血」/ 觉醒「战场再生」：每次击杀回血
    const perkHeal = this.perks.mods.killHeal || 0;
    const awakenMods = this.mode === 'awakening' ? this.awakening.buildMods() : {};
    const awakenHeal = awakenMods.killHeal || 0;
    const totalHeal = perkHeal + awakenHeal;
    if (totalHeal > 0) this.player.health.heal(totalHeal);
    // 连击计数
    const now = performance.now();
    if (now - this._comboLastTime < 2500) {
      this._comboCount += 1;
    } else {
      this._comboCount = 1;
    }
    this._comboLastTime = now;
    clearTimeout(this._comboTimer);
    this._comboTimer = setTimeout(() => {
      this._comboCount = 0;
      this.hud?.hideCombo?.();
    }, 2500);
    if (this._comboCount >= 2) {
      this.hud?.showCombo?.(this._comboCount);
      // 连击音效（3 / 5 / 10 连杀有特殊音调）
      if (this._comboCount === 3 || this._comboCount === 5 || this._comboCount === 10) {
        this.audio?.playSfx?.('chime');
      }
    } else {
      this.hud?.hideCombo?.();
    }
    if (this.defense && this.state === 'playing') {
      this.defense.addGold(DEFENSE.goldPerKill);
    } else {
      this._addRunGold(FIELD.goldPerKill);
    }
    this._updateMissionObjective();
  }

  /** 局内战地金币（闯关 / 无尽） */
  _addRunGold(n) {
    this.runGold += Math.max(0, n);
    if (this.defenseUI) this.defenseUI.setRunGold(this.runGold);
  }

  /**
   * 敌人死亡：首领掉首领核心；地图材料与科研材料按概率直接写入局外存档。
   * 掉率在平衡阶段统一调整。
   */
  _onEnemyDeath(enemy) {
    if (!this.save || this.state !== 'playing' || !enemy?.variant) return;
    // 精英 / 首领额外局内金币（普通击杀的基数已在 _onKill 里发放）
    if (!this.defense) {
      if (enemy.variant.id === 'boss') this._addRunGold(FIELD.goldBoss);
      else if (enemy.variant.id === 'brute' || enemy.variant.id === 'howler') {
        this._addRunGold(FIELD.goldElite);
      }
    }
    const drop = (id, chance) => {
      if (Math.random() < chance) {
        this.save.addMaterial(id, 1);
        this.hud.showSupplyToast(`获得 ${MATERIALS[id].name}`, '已存入局外仓库');
        this.audio.playSfx('pickup');
      }
    };
    if (enemy.variant.id === 'boss') {
      this.save.addMaterial('bossCore', 1);
      this.save.addMaterial('mecha', 1);
      this.save.addMaterial('awaken', 2);
      this.hud.showSupplyToast('首领战利品', '首领核心 +1 · 机甲材料 +1 · 觉醒材料 +2');
      this.audio.playSfx('pickup');
    } else if (enemy.variant.id === 'brute' || enemy.variant.id === 'howler') {
      drop('awaken', 0.06);
    }
    const mapMat = MAP_MATERIAL[this.map?.level?.id];
    if (mapMat) drop(mapMat, 0.06);
    const researchIds = ['researchAmmo', 'researchCombat', 'researchLogistics'];
    const pick = researchIds[Math.floor(Math.random() * researchIds.length)];
    drop(pick, 0.08);
  }

  /** 每一发子弹都记一次，用于算命中率与爆头数 */
  _onShot(info) {
    // perk「子弹时间」：开枪后短暂减缓周围时间
    if (this.perks.mods.slowMoAdd > 0) this._perkSlowTimer = 1.2;
    this.stats.shots += 1;
    if (info && info.hit) this.stats.hits += 1;
    if (info && info.kill && info.headshot) this.stats.headshots += 1;
  }

  _onWaveStart(index, total) {
    const cfg = this.enemies.waves[index];
    this.hud.setWave(index + 1, this.enemies.infinite ? null : this.enemies.waves.length, total);
    this.hud.setEnemies(total);
    let banner = '';
    if (this.mode === 'awakening') banner = `觉醒模式 · 第 ${index + 1} 波`;
    else if (this.mode === 'defense') banner = `守城第 ${index + 1} 波`;
    else if (this.enemies.infinite) banner = `无尽第 ${index + 1} 波`;
    else banner = `第 ${index + 1} 波尸潮`;
    this._showBanner(
      banner,
      `丧尸 ${total} 只 · 同时最多 ${cfg.alive} 只在场${this.mode === 'awakening' ? ` · 每 ${AWAKEN_EVERY} 波觉醒一次` : ''}`
    );
    this._updateMissionObjective();
  }

  _onWaveClear(index, isLast) {
    this.stats.wavesCleared = index + 1;
    this._updateMissionObjective();
    if (isLast) return;   // 最后一波直接走胜利流程
    if (this.defense) {
      // 守城：局内金币奖励 + 免费补给（商店改为 TAB 随时打开）
      this.defense.addGold(DEFENSE.goldPerWave);
      this.gun.addSupply(MATCH.waveClearAmmo);
      this.player.health.addArmor(MATCH.waveClearArmor);
      this.hud.showSupplyToast('战地军需', '按 TAB 打开商店补充火力');
      this._offerPerk();
      return;
    }
    // 闯关 / 无尽：小量免费补给 + 局内金币；军需商店改为 TAB 随时打开
    this.gun.addSupply(MATCH.waveClearAmmoSmall);
    this.player.health.addArmor(MATCH.waveClearArmor);
    this._addRunGold(FIELD.goldPerWave);
    this.hud.showSupplyToast('战地军需', '按 TAB 打开军需商店补充火力');
    this._offerPerk();
  }

  // ---------------- 波间 Roguelike 强化 ----------------
  /** 弹出三选一强化卡片（暂停战斗，选完继续休整） */
  _offerPerk() {
    if (this.state !== 'playing') return;
    const options = this.perks.roll(3);
    if (options.length === 0) return;
    this.state = 'perk';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    if (this._ammoWheelOpen) {
      this._ammoWheelOpen = false;
      this.gun.closeAmmoWheel();
    }
    this.perkUI.show(options, this.perks);
  }

  /** 选中一项强化：立即套用数值并恢复战斗 */
  _pickPerk(id) {
    if (this.state !== 'perk') return;
    const hpBefore = this.player.health.maxHealth;
    const armorBefore = this.player.health.maxArmor;
    const def = this.perks.pick(id);
    this.perkUI.hide();
    if (def) {
      this._applyGrowth();
      // 新增的生命 / 护甲上限立即补满对应数值
      const hpGain = this.player.health.maxHealth - hpBefore;
      const armorGain = this.player.health.maxArmor - armorBefore;
      if (hpGain > 0) this.player.health.heal(hpGain);
      if (armorGain > 0) this.player.health.addArmor(armorGain);
      this.perkUI.renderBadges(this.perks);
      this.hud.showSupplyToast(`强化 · ${def.name}`, def.desc);
      this.audio.playSfx('chime');
    }
    this._resumeFromPerk();
  }

  /** 跳过本次强化（防止卡在面板里） */
  _skipPerk() {
    if (this.state !== 'perk') return;
    this.perkUI.hide();
    this.hud.showSupplyToast('跳过强化', '本波未选择任何增益');
    this._resumeFromPerk();
  }

  _resumeFromPerk() {
    // 觉醒模式：每隔 AWAKEN_EVERY 波，perk 后追加觉醒选项
    if (this.mode === 'awakening') {
      const waveIdx = this.enemies.waveIndex | 0;
      const justCleared = waveIdx + 1;
      if (justCleared > 0 && justCleared % AWAKEN_EVERY === 0) {
        this._offerAwaken();
        return;
      }
    }
    this.state = 'playing';
    this.input.enabled = true;
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
  }

  // ---------------- 觉醒模式专属 ----------------
  /** 弹出觉醒三选一（暂停战斗，选完继续） */
  _offerAwaken() {
    if (this.state !== 'perk' && this.state !== 'playing') return;
    const options = this.awakening.roll(3);
    if (!options.length) {
      this._resumeFromAwaken();
      return;
    }
    this.state = 'awaken';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    if (this._ammoWheelOpen) {
      this._ammoWheelOpen = false;
      this.gun.closeAmmoWheel();
    }
    this.awakenUI.show(options, this.awakening);
    // 觉醒闪光 + 屏幕震动（postFX hit-red 短暂爆发）
    this.postfx?.setDamage(1.0);
    this.audio?.playSfx?.('alarm');
  }

  /** 选中一项觉醒 perk，可能触发形态解锁 */
  _pickAwaken(id) {
    if (this.state !== 'awaken') return;
    const hpBefore = this.player.health.maxHealth;
    const armorBefore = this.player.health.maxArmor;
    const result = this.awakening.pick(id);
    this.awakenUI.hide();
    if (result) {
      this._applyGrowth();
      // 新增的生命 / 护甲上限立即补满
      const hpGain = this.player.health.maxHealth - hpBefore;
      const armorGain = this.player.health.maxArmor - armorBefore;
      if (hpGain > 0) this.player.health.heal(hpGain);
      if (armorGain > 0) this.player.health.addArmor(armorGain);
      // HUD 常驻形态徽章
      this.awakenUI.renderBadges(this.awakening);
      this.hud.showSupplyToast(`觉醒 · ${result.def.name}`, result.def.desc);
      this.audio.playSfx('chime');
      // 形态解锁：额外 toast + 视觉反馈
      for (const f of result.newForms) {
        this.hud.showSupplyToast(`★ 形态解锁 ${f.route === 'fury' ? '狂暴' : f.route === 'warden' ? '守护' : '异能'} Lv.${f.level}`, '新形态额外强化已激活');
        this.audio.playSfx('alarm');
        this.postfx?.setDamage(0.6);
      }
    }
    this._resumeFromAwaken();
  }

  _skipAwaken() {
    if (this.state !== 'awaken') return;
    this.awakenUI.hide();
    this.hud.showSupplyToast('暂不觉醒', '下次觉醒窗口再见');
    this._resumeFromAwaken();
  }

  _resumeFromAwaken() {
    this.state = 'playing';
    this.input.enabled = true;
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
  }

  // ---------------- 守城商店（TAB 常驻） ----------------
  /** 守城模式下随时打开军需商店；关闭后继续当前战斗 */
  _openDefenseShop() {
    if (!this.defense || !this.defenseUI) return;
    this._fieldShop = false;
    this.state = 'shop';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    if (this._ammoWheelOpen) {
      this._ammoWheelOpen = false;
      this.gun.closeAmmoWheel();
    }
    this.defenseUI.showShop(this.defense.getShopState(), this.enemies.waveIndex + 1);
    this.defenseUI.shopSub.textContent = '战地军需 · 随时补给（TAB 打开 / Esc 关闭）';
  }

  _closeShop() {
    if (this.state !== 'shop') return;
    this.defenseUI.hideShop();
    this._fieldShop = false;
    this.state = 'playing';
    this.input.enabled = true;
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
  }

  // ---------------- 行囊 ----------------
  _openInventory() {
    if (this.state !== 'playing' || !this.inventory) return;
    this.state = 'inventory';
    this.input.enabled = false;
    this.input.releaseLock();
    if (this.gun) {
      this.gun.setMouseDown(false);
      this.gun.setAiming(false);
    }
    this.inventory.open();
  }

  _closeInventory() {
    if (this.state !== 'inventory') return;
    this.state = 'playing';
    this.input.enabled = true;
    this._ignoreBlurUntil = performance.now() + 800;
    this.input.requestLock();
  }

  /** 行囊物品使用：返回 true 才扣减数量 */
  _useInventoryItem(type) {
    if (this.state !== 'inventory' || !this.player) return false;
    if (type === 'medkit') {
      if (this.player.health.health >= this.player.health.maxHealth) {
        this.hud.showSupplyToast('生命已满', '急救包留到受伤时再用');
        return false;
      }
      this.player.health.heal(50);
      this.hud.showSupplyToast('使用 急救包', '生命 +50');
      return true;
    }
    if (type === 'armor') {
      if (this.player.health.armor >= this.player.health.maxArmor) {
        this.hud.showSupplyToast('护甲已满', '护甲板留到受损时再用');
        return false;
      }
      this.player.health.addArmor(25);
      this.hud.showSupplyToast('使用 护甲板', '护甲 +25');
      return true;
    }
    if (type === 'ammo') {
      if (!this.gun) return false;
      this.gun.addSupply(30);
      this.hud.showSupplyToast('使用 弹药箱', '备弹 +30');
      return true;
    }
    if (type === 'throwable') {
      const kind = this.throwSystem.grantCache();
      this.hud.showSupplyToast('使用 投掷包', kind === 'frag' ? '手雷 +1' : '燃烧瓶 +1');
      return true;
    }
    return false;
  }

  _buyShopItem(id) {
    if (this._fieldShop) this._buyFieldItem(id);
    else this._buyDefenseItem(id);
  }

  _buyDefenseItem(id) {
    if (!this.defense) return;
    const res = this.defense.buy(id);
    this.defenseUI.updateShop(this.defense.getShopState(), res.message);
    if (!res.ok) this.hud.showSupplyToast('军需购买失败', res.message);
  }

  // ---------------- 关卡间商店（闯关 / 无尽） ----------------
  /**
   * 波次肃清后自动打开的战地军需商店。
   * 复用 DefenseUI 的商店面板，商品与货币换成局内战地金币。
   */
  _openFieldShop() {
    if (!this.defenseUI || this.defense || this.state !== 'playing') return;
    this.state = 'shop';
    this._fieldShop = true;
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    if (this._ammoWheelOpen) {
      this._ammoWheelOpen = false;
      this.gun.closeAmmoWheel();
    }
    this.defenseUI.setRunGold(this.runGold);
    this.defenseUI.showShop(
      { gold: this.runGold, items: this._fieldShopItems() },
      this.enemies.waveIndex + 1,
      '购买'
    );
    if (this.defenseUI.shopTitle) this.defenseUI.shopTitle.textContent = '战地军需';
    if (this.defenseUI.shopKicker) this.defenseUI.shopKicker.textContent = 'FIELD SUPPLY';
    if (this.defenseUI.shopContinue) this.defenseUI.shopContinue.textContent = '返回战斗';
    this.defenseUI.shopSub.textContent = '战地军需 · 用局内金币随时补给（TAB 打开 / Esc 关闭）';
  }

  /** 局内商店商品列表（带可买状态与提示） */
  _fieldShopItems() {
    const h = this.player.health;
    return FIELD.order.map((id) => {
      const it = FIELD.items[id];
      let disabled = false;
      let tip = '局内补给';
      if (it.kind === 'ammo') {
        const cur = this.gun.reserveOf(it.weapon);
        const cap = this.gun.reserveCap(it.weapon);
        tip = `备弹 ${Math.round(cur)}/${cap}`;
        if (cur >= cap) { disabled = true; tip = '备弹已满'; }
      } else if (it.kind === 'armor') {
        tip = `护甲 ${Math.round(h.armor)}/${Math.round(h.maxArmor)}`;
        if (h.armor >= h.maxArmor - 0.01) { disabled = true; tip = '护甲已满'; }
      } else if (it.kind === 'heal') {
        tip = `生命 ${Math.round(h.health)}/${Math.round(h.maxHealth)}`;
        if (h.health >= h.maxHealth - 0.01) { disabled = true; tip = '生命已满'; }
      } else if (it.kind === 'trap') {
        tip = this.trapSystem.blueprint === it.trap ? '已持有该蓝图' : '购买后按 F 放置';
      }
      return {
        id,
        name: it.name,
        desc: it.desc,
        costLabel: `${it.cost} 金币`,
        tip,
        affordable: this.runGold >= it.cost,
        disabled,
      };
    });
  }

  _buyFieldItem(id) {
    const it = FIELD.items[id];
    if (!it || !this.defenseUI) return;
    if (this.runGold < it.cost) {
      this.defenseUI.updateShop(
        { gold: this.runGold, items: this._fieldShopItems() },
        '局内金币不足'
      );
      return;
    }
    let applied = 0;
    if (it.kind === 'ammo') {
      applied = this.gun.addSupplyFor(it.weapon, it.amount);
    } else if (it.kind === 'armor') {
      const before = this.player.health.armor;
      this.player.health.addArmor(it.amount);
      applied = this.player.health.armor - before;
    } else if (it.kind === 'heal') {
      applied = this.player.health.heal(it.amount);
    } else if (it.kind === 'full') {
      for (const w of WEAPON_UNLOCKED) applied += this.gun.addSupplyFor(w, 9999);
      const beforeArmor = this.player.health.armor;
      this.player.health.addArmor(9999);
      applied += this.player.health.armor - beforeArmor;
      const beforeHp = this.player.health.health;
      this.player.health.heal(9999);
      applied += this.player.health.health - beforeHp;
    } else if (it.kind === 'trap') {
      applied = this.trapSystem.setBlueprint(it.trap) ? 1 : 0;
    }
    if (applied <= 0) {
      this.defenseUI.updateShop(
        { gold: this.runGold, items: this._fieldShopItems() },
        '该项已满，未扣除金币'
      );
      return;
    }
    this.runGold -= it.cost;
    this.defenseUI.setRunGold(this.runGold);
    this.defenseUI.updateShop(
      { gold: this.runGold, items: this._fieldShopItems() },
      `${it.name} 补给完成`
    );
    this.hud.showSupplyToast(it.name, it.desc);

    // 装置购买后立刻收起商店，方便玩家走到位置按 F 放置
    if (it.kind === 'trap') {
      this._closeShop();
      this.hud.showSupplyToast('蓝图已就绪', `走到位置按 F 放置${it.name}（B 取消）`);
    }
  }

  // ---------------- 局内任务目标 ----------------
  /**
   * 选取进度最高的「进行中」任务，显示在局内 HUD 左侧。
   * 进度 = 存档累计战绩 + 本局实时战绩（击杀 / 波次等）。
   * 优先展示能在一局内推进的任务（击杀 / 波次），没有再退回其它任务。
   */
  _updateMissionObjective() {
    if (!this.hud) return;
    const claimed = this.save.data.meta.claimedMissions || [];
    const base = this.save.data.stats;
    // 合并本局实时数据，让任务目标随对局推进
    const merged = {
      runs: base.runs,
      kills: base.kills + (this.stats.kills || 0),
      bestWave: Math.max(base.bestWave, this.stats.wavesCleared || 0),
      bestLevel: base.bestLevel,
    };
    const pending = MISSIONS
      .filter((m) => !claimed.includes(m.id))
      .map((m) => ({ m, progress: missionProgress(m, merged) }))
      .filter(({ m, progress }) => progress < m.target);
    if (!pending.length) {
      this.hud.hideMissionObjective();
      return;
    }
    const inRun = new Set(['kills', 'bestWave']);
    const inRunList = pending.filter(({ m }) => inRun.has(m.metric));
    const list = inRunList.length ? inRunList : pending;
    let best = list[0];
    for (const item of list) {
      if (item.progress / item.m.target > best.progress / best.m.target) best = item;
    }
    this.hud.setMissionObjective(best.m.name, best.progress, best.m.target);
  }

  _onCoreDestroyed() {
    if (this.state !== 'playing') return;
    this.hud.showSupplyToast('领地核心被摧毁', '守城失败');
    this._endMatch(false);
  }

  _onVictory() {
    if (this.state !== 'playing') return;
    this._endMatch(true);
  }

  /** 把本局剩余备弹写回局外库存（闯关 / 无尽；守城免费不结算） */
  _persistAmmoStock() {
    if (isDefenseMode(this.mode) || !this.gun || !this.save) return;
    this.save.data.meta.ammoStock = this.gun.collectAmmoStock();
    this.save.save();
  }

  /** 结束一局：true 胜利 / false 阵亡 */
  _endMatch(win) {
    this.stats.endedAt = performance.now();
    this._persistAmmoStock();
    this.state = 'result';
    this.throwSystem.cancel();
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.hud.setVisible(false);
    if (this.defenseUI) {
      this.defenseUI.hideShop();
      this.defenseUI.setRunGoldVisible(false);
    }
    this._fieldShop = false;
    if (this.growthUI) this.growthUI.hide();
    this.mech?.reset();
    if (this.defense && this.defense.isMounted) this.defense.dismount();
    const result = this._buildResult(win);
    // 局外存档：累计战绩 + 金币 / 声望 / 核心结算（闯关记关卡编号，无尽只记波次）
    result.rewards = this.save.recordRun({
      kills: result.kills,
      seconds: result.seconds,
      level: this.mode === 'campaign' ? this.levelIndex + 1 : null,
      wave: result.wavesCleared,
      win,
    });
    this._refreshLobby();
    this.menu.showResult(result);
  }

  /** 汇总本局数据：命中率 / 用时 / 得分 / 评级 */
  _buildResult(win) {
    const s = this.stats;
    const seconds = Math.max(1, (s.endedAt - s.startedAt) / 1000);
    const accuracy = computeAccuracy(s.shots, s.hits);
    const score = computeScore(s, seconds);
    const infinite = this.enemies.infinite;
    const defense = isDefenseMode(this.mode);
    let title = win ? '区域肃清' : '行动阵亡';
    let kicker = win ? 'MISSION COMPLETE' : 'MISSION FAILED';
    if (defense) {
      title = win ? '领地守住' : '核心被摧毁';
      kicker = win ? 'DEFENSE COMPLETE' : 'DEFENSE FAILED';
    }
    if (infinite) {
      title = defense ? '守城终止' : '生存终止';
      kicker = 'RUN ENDED';
    }
    return {
      win,
      infinite,
      defense,
      mode: this.mode,
      title,
      kicker,
      score,
      grade: pickGrade(score, MATCH.grades),
      kills: s.kills,
      headshots: s.headshots,
      accuracy,
      seconds,
      damageTaken: Math.round(s.damageTaken),
      wavesCleared: s.wavesCleared,
      waveTotal: infinite ? null : this.enemies.waves.length,
      totalEnemies: this.enemies.waves.reduce((n, w) => n + w.total, 0),
      // 闯关胜利且还有下一关：结算面板显示「进入下一关」
      nextLevel: (this.mode === 'campaign' && win && this.levelIndex + 1 < LEVELS.length - 1)
        ? this.levelIndex + 2
        : null,
    };
  }

  /**
   * 结算面板「进入下一关」：直接加载下一张地图并开始新一局。
   * 局内战地金币清空，局外备弹库存保留（上一关剩下的备弹带过去）。
   */
  nextLevel() {
    if (this.mode !== 'campaign' || this.state !== 'result') return;
    const next = this.levelIndex + 1;
    if (next >= LEVELS.length - 1) {
      this.backToMenu();
      return;
    }
    this.levelIndex = next;
    // 刷新本关波次（关卡系数）后再换图开局
    this._applyMode('campaign');
    this._loadMap(next);
    this.menu.hideAll();
    this.restart();
    this._showBanner(`第 ${next + 1} 关`, this.map.level?.name || '');
  }

  /** 屏幕中央的波次横幅（自动淡出） */
  _showBanner(title, sub) {
    const el = this.waveBannerEl;
    if (!el) return;
    el.querySelector('[data-role="title"]').textContent = title;
    el.querySelector('[data-role="sub"]').textContent = sub || '';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------------- 公网部署：环境检测 ----------------
  /** 检测 WebGL 支持；不支持时给出友好提示并阻止继续初始化 */
  _checkWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const ok = !!(window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')));
      if (ok) return true;
    } catch (e) { /* ignore */ }
    const text = document.getElementById('loading-text');
    if (text) {
      text.textContent = '当前浏览器不支持 WebGL，无法运行本游戏';
      text.style.color = '#ff5a2d';
    }
    const hint = document.querySelector('.loading-hint');
    if (hint) hint.innerHTML = '请使用最新版 Chrome / Edge / QQ / 360 浏览器，并开启硬件加速后重试。';
    return false;
  }

  /** 检测访问协议：非 HTTPS（且非 localhost）时，提示鼠标锁定可能被浏览器禁用 */
  _checkProtocol() {
    const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
    if (location.protocol === 'http:' && !isLocal) {
      const banner = document.createElement('div');
      banner.id = 'http-warning';
      banner.textContent = '当前为 HTTP 访问，浏览器限制鼠标锁定功能，推荐使用 HTTPS 链接打开游戏';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
        'background:rgba(180,40,20,0.92)', 'color:#fff', 'font:13px/1.6 sans-serif',
        'padding:8px 16px', 'text-align:center', 'box-shadow:0 2px 10px rgba(0,0,0,0.4)',
      ].join(';');
      document.body.appendChild(banner);
    }
  }

  // ---------------- 美术：PCSS 软阴影 ----------------
  /** 检测是否为软件渲染（无头浏览器 / 无 GPU），用于跳过 PCSS 与 SSAO */
  _detectSoftwareGL() {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || ''));
      return /swiftshader|software|llvmpipe|basic render/i.test(name);
    } catch (e) {
      return false;
    }
  }

  /**
   * 把内置的固定半径 PCF 阴影替换为 PCSS（百分比渐近软阴影）：
   * 先做阻塞物搜索，用「遮挡物深度与接收面深度之差」估算半影，
   * 再做可变半径 PCF —— 贴近地面的接触阴影锐利，远处投影边缘自然变柔。
   * 只有着色器块结构与预期一致时才替换，避免不同 Three.js 版本上炸掉阴影。
   */
  _enablePCSS() {
    if (Game._pcssPatched) return;
    const chunk = THREE.ShaderChunk && THREE.ShaderChunk.shadowmap_pars_fragment;
    const oldHead = 'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {';
    if (!chunk || chunk.indexOf(oldHead) < 0) return;   // 版本不符：保持默认阴影
    const pcss = `
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
	float shadow = 1.0;
	shadowCoord.xyz /= shadowCoord.w;
	shadowCoord.z += shadowBias;
	bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
	bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
	if ( frustumTest ) {
		vec2 texel = vec2( 1.0 ) / shadowMapSize;
		float search = max( 1.5, shadowRadius ) * 1.35;
		float receiver = shadowCoord.z;
		float blockerSum = 0.0;
		float blockerCount = 0.0;
		for ( int i = 0; i < 6; i ++ ) {
			float fi = float( i );
			float ang = fi * 2.39996323;
			float rad = sqrt( ( fi + 0.5 ) / 6.0 );
			vec2 off = vec2( cos( ang ), sin( ang ) ) * rad * search * texel;
			float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + off ) );
			if ( d < receiver ) { blockerSum += d; blockerCount += 1.0; }
		}
		if ( blockerCount < 0.5 ) {
			shadow = 1.0;
		} else {
			float avgBlocker = blockerSum / blockerCount;
			float penumbra = clamp( ( receiver - avgBlocker ) * 260.0, 1.0, 10.0 );
			float sum = 0.0;
			for ( int i = 0; i < 8; i ++ ) {
				float fi = float( i );
				float ang = fi * 2.39996323 + 1.7;
				float rad = sqrt( ( fi + 0.5 ) / 8.0 );
				vec2 off = vec2( cos( ang ), sin( ang ) ) * rad * penumbra * texel;
				sum += step( receiver, unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + off ) ) );
			}
			shadow = sum / 8.0;
		}
	}
	return shadow;
}
`;
    THREE.ShaderChunk.shadowmap_pars_fragment = chunk.replace(
      oldHead,
      'float basShadowLegacy( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {'
    ) + pcss;
    Game._pcssPatched = true;
  }

  // ---------------- 美术：程序化环境贴图 ----------------
  /**
   * 用一间"摄影棚"（渐变天幕 + 高亮柔光板 + 暖色反光板）生成 PMREM 环境贴图。
   * PBR 金属材质（枪械）没有环境反射时会渲染成纯黑，有了这张图才有金属质感。
   */
  _buildEnvironmentMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();

    // 天幕：上亮下暗的渐变球（提供整体环境亮度与方向感）
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#d8e8ff');
    grad.addColorStop(0.5, '#eef2f6');
    grad.addColorStop(1, '#3e4348');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 64);
    const domeTex = new THREE.CanvasTexture(c);
    domeTex.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(100, 16, 12),
      new THREE.MeshBasicMaterial({ map: domeTex, side: THREE.BackSide })
    );
    envScene.add(dome);

    // 高亮柔光板：让枪械金属表面出现长条柔和高光
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 26),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    panel.position.set(-45, 55, 25);
    panel.rotation.set(-0.55, 0.6, 0);
    envScene.add(panel);

    const panel2 = new THREE.Mesh(
      new THREE.PlaneGeometry(45, 20),
      new THREE.MeshBasicMaterial({ color: 0xdfe9ff })
    );
    panel2.position.set(50, 22, -30);
    panel2.rotation.set(0.25, -0.85, 0);
    envScene.add(panel2);

    // 暖色反光板：给暗部一点暖调，避免金属死黑
    const warm = new THREE.Mesh(
      new THREE.PlaneGeometry(36, 18),
      new THREE.MeshBasicMaterial({ color: 0xffd39a })
    );
    warm.position.set(8, -22, 45);
    warm.rotation.set(0.2, 0, 0);
    envScene.add(warm);

    const rt = pmrem.fromScene(envScene, 0.06);
    this.scene.environment = rt.texture;
    this._envRT = rt;   // 保留引用，避免被回收
    pmrem.dispose();
    domeTex.dispose();
  }

  // ---------------- 主循环 ----------------
  _loop() {
    const dt = Math.min(0.05, this.clock.getDelta());
    // 第三轮：FPS 统计（每 0.5 秒刷新一次显示）
    this._fpsFrames += 1;
    this._fpsAcc += dt;
    if (this._fpsAcc >= 0.5) {
      if (this.fpsValue && this._fpsVisible) {
        this.fpsValue.textContent = Math.round(this._fpsFrames / this._fpsAcc);
      }
      this._fpsFrames = 0;
      this._fpsAcc = 0;
    }
    this._tickDynamicResolution(dt);
    this._update(dt);
    // 大厅态渲染 3D 基地；面板态保留大厅作为背景；其余渲染战斗场景
    if ((this.state === 'lobby' || this.state === 'lobby_panel') && this.lobby) {
      if (this.state === 'lobby_panel') this.lobby.tick(dt);
      this.lobby.render(this.renderer);
    } else {
      this.postfx.render(this.scene, this.camera);
      // 武器最后单独画一遍（清深度 + 独立场景），保证枪身不插进墙里
      this.weaponView.renderOverlay(this.renderer);
    }
  }

  /**
   * 动态分辨率：按平均帧时间在 0.6~1.0 之间缩放绘制缓冲。
   * 只调 pixelRatio，HUD / 交互全部不受影响，掉帧时优先保帧率。
   */
  _tickDynamicResolution(dt) {
    const d = this._dynRes;
    if (!d || !d.enabled) return;
    if (this.state !== 'playing') { d.acc = 0; d.n = 0; return; }
    if (d.settle > 0) { d.settle -= dt; d.acc = 0; d.n = 0; return; }
    d.acc += dt;
    d.n += 1;
    if (d.n < 45 && d.acc < 0.9) return;
    const avgMs = (d.acc / d.n) * 1000;
    d.acc = 0;
    d.n = 0;
    let scale = d.scale;
    if (avgMs > 21.5) scale = Math.max(0.6, scale - (avgMs > 33 ? 0.15 : 0.1));
    else if (avgMs < 16.8) scale = Math.min(d.max, scale + 0.1);
    scale = Math.round(scale * 10) / 10;
    if (scale !== d.scale) {
      d.scale = scale;
      d.settle = 1.2;
      this._applyRenderScale();
    }
    // 已经缩到最低还掉帧：关掉 AO、把阴影贴图降到 1024（软件渲染 / 集显兜底）
    if (d.scale <= 0.6 && avgMs > 30) {
      d.floorHits = (d.floorHits || 0) + 1;
      if (d.floorHits >= 2 && !d.degraded) {
        d.degraded = true;
        d.floorHits = 0;
        if (this.postfx) {
          this.postfx.aoEnabled = false;
          this.postfx.aoStrength = 0;
        }
        if (this._dnSun && this._dnSun.shadow.mapSize.x > 1024) {
          this._dnSun.shadow.mapSize.set(1024, 1024);
          if (this._dnSun.shadow.map) {
            this._dnSun.shadow.map.dispose();
            this._dnSun.shadow.map = null;
          }
        }
      }
    } else {
      d.floorHits = 0;
    }
  }

  /** 按当前动态分辨率重建绘制缓冲与 PostFX 目标 */
  _applyRenderScale() {
    const q = this._quality || QUALITY.high;
    const base = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
    const scale = this._dynRes ? this._dynRes.scale : 1;
    this.renderer.setPixelRatio(base * scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.postfx) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.postfx.setSize(size.x, size.y);
    }
    if (this.gun) {
      this.gun._viewportWidth = window.innerWidth;
      this.gun._viewportHeight = window.innerHeight;
    }
  }

  _update(dt) {
    // 合成音源推进（BGM 脉冲 / 风声 / 随机乌鸦）
    this.audio.update(dt);
    // 听者跟随相机：PannerNode 的距离与前后定位靠这个才准
    if (this.state !== 'lobby' && this.state !== 'lobby_panel' && this.audio.setListener) {
      this.audio.setListener(this.camera);
    }
    // 后期处理（受击闪红衰减）
    this.postfx.update(dt);
    // 调试：F1 随时切换 FPS 面板（暂停/死亡时也可用）
    if (this.input.consumeAction('debugFps')) this._toggleFps();

    // 输入（键盘边沿事件在暂停/死亡时仍然有效）
    if (this.state === 'lobby') {
      // 3D 大厅：自由漫游 + 设施交互
      const nearest = this.lobby.update(dt, this.input);
      this._updateLobbyInteract(nearest);
      if (this.input.consumeAction('panel')) {
        // TAB：打开完整面板（停在上次页签）
        this.openLobbyPanel(this.menu.lobby.activeTab || 'battle');
      } else if (this.input.consumeAction('pickup') && nearest) {
        // F：打开脚下设施对应的页签
        this.openLobbyPanel(nearest.def.tab);
      }
    } else if (this.state === 'lobby_panel') {
      // 面板态：大厅只保留待机动画；TAB / Esc 关闭回漫游
      this.lobby.tick(dt);
      if (this.input.consumeAction('pause') || this.input.consumeAction('panel')) {
        this.closeLobbyPanel();
      }
    } else if (this.state === 'playing') {
      const input = this.input;
      const defense = this.defense;
      const mounted = !!(defense && defense.isMounted);
      const carrying = !!(defense && defense.isCarrying);

      // 鼠标视角（弹种轮盘打开时，鼠标位移用于选弹而不是转视角）
      // 右键开镜切换（toggle）：按一下开、再按一下关
      if (input.consumeAction('aim')) this.aiming = !this.aiming;
      const aiming = !mounted && !carrying && this.aiming;
      this.gun.setAiming(aiming);

      let delta = input.consumeMouseDelta();
      const wheelHeld = !mounted && !carrying && input.actionDown('ammoWheel');
      if (wheelHeld) {
        if (!this._ammoWheelOpen) {
          this._ammoWheelOpen = true;
          this.gun.openAmmoWheel();
        }
        this.gun.updateAmmoWheel(delta.x, delta.y);
        delta = { x: 0, y: 0 };
      } else if (this._ammoWheelOpen) {
        this._ammoWheelOpen = false;
        this.gun.closeAmmoWheel();
      }
      this.mouseLook.onMouseMove(delta.x, delta.y);

      // 换弹（Ctrl+R 打开轮盘时不触发换弹；操作场景武器时交给场景武器）
      if (!wheelHeld && !mounted && !carrying && input.consumeAction('reload')) this.gun.startReload();

      if (!mounted && !carrying) {
        const slots = ['rifle', 'pistol', 'shotgun', 'sniper', 'smg', 'rpg'];
        for (let i = 0; i < slots.length; i++) {
          if (input.consumeAction('weapon' + (i + 1)) && slots[i]) {
            this.gun.switchWeapon(slots[i]);
          }
        }
        const wheel = input.consumeWheel();
        if (Math.abs(wheel) > 30) this.gun.switchWeaponByDelta(wheel);

        // G / H：进入手雷 / 燃烧瓶投掷态（再按一次取消）
        if (!this.debugEl) {
          if (input.consumeAction('grenade')) this._toggleThrow('frag');
          if (input.consumeAction('molotov')) this._toggleThrow('molotov');
        }
      } else {
        input.consumeWheel();
      }

      // 拾取：场景武器交互优先，其次才是补给箱
      if (input.consumeAction('pickup')) {
        if (this.trapSystem.blueprint) {
          // 手持蓝图时 F 优先放置装置
          const placed = this.trapSystem.tryPlace();
          this.hud.showSupplyToast(placed.ok ? '装置已布置' : '无法放置', placed.message);
        } else {
          const handled = defense ? defense.tryInteract() : false;
          if (!handled) {
            const got = this.supplies.pickupNearest();
            if (!got) this.hud.showSupplyToast('附近没有补给', '靠近补给箱再按 F');
          }
        }
      }
      if (input.consumeAction('autoPickup')) this._toggleAutoPickup();

      // 背包键：持蓝图时用于取消放置，否则打开行囊
      if (input.consumeAction('backpack')) {
        if (this.trapSystem.blueprint) {
          this.trapSystem.clearBlueprint();
          this.hud.showSupplyToast('已收起蓝图', '按 B 取消放置');
        } else {
          this._openInventory();
        }
      }
      if (input.consumeAction('map')) this._featureSoon('地图', '战术地图开发中');
      if (input.consumeAction('panel')) {
        // TAB = 军需商店（守城 / 闯关 / 无尽通用，随时补给）
        if (this.defense) this._openDefenseShop();
        else this._openFieldShop();
      }
      // V = 成长面板（机甲 / 天赋 / 觉醒）
      if (input.consumeAction('growth')) this._openGrowthPanel();
      for (let i = 1; i <= 7; i++) {
        if (input.consumeAction('skill' + i)) this._featureSoon(`技能 ${i}`, '技能系统开发中');
      }

      // Esc 暂停
      if (input.consumeAction('pause')) this.pauseGame();

      // 玩家 + 枪械 / 场景武器（轮盘打开时暂停射击）
      const wheelOpen = this._ammoWheelOpen;
      if (mounted) {
        // 上机：锁定站位，由场景武器接管视角与开火
        this.player.velocity.set(0, 0, 0);
        this.mouseLook.update(dt);
        defense.updateMounted(dt, input.actionDown('fire'), input.actionPressed('fire'));
        this.gun.setMouseDown(false);
        this.gun.setFirePressed(false);
      } else {
        this.player.update(dt, this.mouseLook);
        if (carrying) {
          defense.updateCarried(dt, !wheelOpen && input.actionDown('fire'), !wheelOpen && input.actionPressed('fire'));
          this.gun.setMouseDown(false);
          this.gun.setFirePressed(false);
        } else {
          // 投掷态下左键用于蓄力，不触发开枪
          const throwing = !!this.throwSystem.mode;
          this.gun.setMouseDown(!throwing && !wheelOpen && input.actionDown('fire'));
          this.gun.setFirePressed(!throwing && !wheelOpen && input.actionPressed('fire'));
          this.gun.update(dt, delta, !throwing);
          this.throwSystem.updateAim(dt, !throwing && !wheelOpen && input.actionDown('fire'));
        }
      }

      // 调试模式快捷键：G 自伤（用于自动化测试，普通模式无效）
      if (this.debugEl) {
        if (this.input.consume('KeyG')) {
          this.player.takeDamage(35);
          this.hud.showDamage();
        }
      }

      // 敌人（perk「子弹时间」期间周围时间流速降低）
      let enemyDt = dt;
      if (this._perkSlowTimer > 0) {
        this._perkSlowTimer -= dt;
        enemyDt = dt * (1 - this.perks.slowMo);
      }
      this.enemies.update(enemyDt);

      // BGM 张力：波次越靠后越紧张
      const waveIdx = this.enemies.waveIndex | 0;
      const waveTotal = this.enemies.infinite ? 10 : Math.max(1, this.enemies.waves.length);
      this.audio.setBattleIntensity(Math.min(1, waveIdx / waveTotal));

      // 场景可爆炸物（油桶 / 汽车引信与连锁爆炸）
      this.explosions.update(dt);

      // 投掷物（手雷 / 燃烧瓶飞行、引信与地面火区）
      this.throwSystem.update(dt);

      // 陷阱与炮塔（地雷触发 / 喷火 / 电网 / 自动索敌）
      this.trapSystem.update(dt);

      // 机甲形态燃料 / 护盾 / 哨戒炮塔
      this.mech.update(dt);

      // 守城运行时：核心受击、炮塔 / 人机索敌、武器降温
      if (defense) {
        defense.update(dt);
        this.defenseUI.setInteract(defense.interactHint());
      }

      // 补给点（靠近自动拾取 / 冷却刷新）
      this.supplies.update(dt);

      // 交互提示：靠近可拾取补给时显示「F 拾取 · xxx」并高亮准星
      const nearPickup = this.supplies.nearestPrompt();
      if (nearPickup && !this.defense) this.hud.showInteract(`拾取 · ${nearPickup}`);
      else this.hud.hideInteract();

      // 特效与弹壳
      this.effects.update(dt);
      this.casings.update(dt);

      // 昼夜 / 天气循环（playing 状态推进时间，大厅/暂停停住不动）
      this.dayNight.update(dt, true);

      // 天气联动：下雨时开启雨幕，同时把地面打湿（粗糙度下降 → 环境反射变强）
      const rainy = this._dnState.weather === 'rain';
      this.rain.setEnabled(rainy);
      this.rain.update(dt, this.camera.position);
      const floorMat = this.map && this.map.matFloor;
      if (floorMat) {
        const k = Math.min(1, dt * 0.9);
        floorMat.roughness += ((rainy ? 0.38 : 0.95) - floorMat.roughness) * k;
        floorMat.metalness += ((rainy ? 0.16 : 0.02) - floorMat.metalness) * k;
        const envI = rainy ? 1.5 : 1.0;
        floorMat.envMapIntensity += (envI - (floorMat.envMapIntensity ?? 1)) * k;
      }

      // HUD 数值
      this.hud.setHealth(this.player.health.health);
      this.hud.setArmor(this.player.health.armor);
      this.hud.setEnemies(this.enemies.waveRemaining);
      this.throwUI.update(this.throwSystem, this.trapSystem.blueprintName);

      // 小地图雷达每帧刷新
      if (this.hud.minimap) {
        this.hud.minimap.draw({
          playerPos: this.player.position,
          playerYaw: this.mouseLook.yaw,
          enemies: this.enemies.enemies,
          spawnPoints: this.map.spawnPoints || [],
        });
      }


      // 受击反馈：生命 + 护甲总量下降时触发边缘闪红
      const vital = this.player.health.health + this.player.health.armor;
      if (this._lastVital !== null && vital < this._lastVital) this.postfx.setDamage(1);
      this._lastVital = vital;

      // 低血量状态（生命占比 < 30%）：屏幕边框警告 + 心跳节拍
      const hpRatio = this.player.health.health / Math.max(1, this.player.health.maxHealth);
      if (this.hud.lowhpOverlay) {
        const isLow = hpRatio < 0.30;
        this.hud.lowhpOverlay.classList.toggle('hidden', !isLow);
      }

      // 死亡判定
      if (this.player.dead && this.state === 'playing') this._endMatch(false);
    } else if (this.state === 'shop') {
      // 军需商店：敌人与核心暂停推进，只保留场景演出
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
      if (this.input.consumeAction('pause') || this.input.consumeAction('panel')) {
        this._closeShop();
      }
    } else if (this.state === 'inventory') {
      // 行囊：战斗暂停，B / Esc 关闭
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
      this.hud.hideInteract();
      if (this.input.consumeAction('pause') || this.input.consumeAction('backpack')) {
        this.inventory.close();
      }
    } else if (this.state === 'perk') {
      // 三选一强化面板：战斗完全暂停，只保留场景演出
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
      if (this.input.consumeAction('pause')) this._skipPerk();
    } else if (this.state === 'awaken') {
      // 觉醒面板：战斗完全暂停，只保留场景演出
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
      if (this.input.consumeAction('pause')) this._skipAwaken();
    } else if (this.state === 'panel') {
      // 成长面板：战斗暂停，只保留场景演出；V / ESC 关闭
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
      if (this.input.consumeAction('pause') || this.input.consumeAction('growth')) {
        this._closeGrowthPanel();
      }
    } else if (this.state === 'result') {
      // 结算界面保留场景渲染（轻微演出），但不再推进战斗
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
      // Esc 退出结算面板，回到大厅
      if (this.input.consumeAction('pause')) this.backToMenu();
    } else if (this.state === 'paused') {
      this.input.consume('KeyR');
      this.mouseLook.update(0);
      // Esc 再按一次继续（刚暂停的 0.35 秒内不响应，避免解锁瞬间误触）
      if (this._pauseGuard > 0) this._pauseGuard -= dt;
      else if (this.input.consumeAction('pause')) this.resumeGame();
    }

    // 确保每帧结束清理边沿输入
    this.input.endFrame();

    // 调试面板刷新
    if (this.debugEl) {
      this._debugTimer = (this._debugTimer || 0) + dt;
      if (this._debugTimer > 0.15) {
        this._debugTimer = 0;
        const anims = Object.entries(this.assets.anims)
          .map(([k, v]) => k + (v ? '+' : '-')).join(' ');
        this.debugEl.textContent =
          `state=${this.state} locked=${this.input.locked} mouseDown=${this.input.mouseDown}\n` +
          `weapon=${this.assets.weaponModel ? 'ok' : 'MISSING'} mag=${this.gun.mag}/${this.gun.reserve} reload=${this.gun.reloading}\n` +
          `player=${this.player.position.x.toFixed(1)},${this.player.position.y.toFixed(1)},${this.player.position.z.toFixed(1)} ` +
          `grounded=${this.player.grounded} hp=${Math.round(this.player.health.health)}\n` +
          `wave=${this.enemies.waveIndex + 1}/${this.enemies.infinite ? '∞' : this.enemies.waves.length} state=${this.enemies.waveState} ` +
          `alive=${this.enemies.aliveCount} left=${this.enemies.waveRemaining} kills=${this.enemies.kills} anims=${anims}\n` +
          `spread=${this.gun.spread.toFixed(3)}` +
          (this.weaponView.modelSize
            ? `\nviewSize=${this.weaponView.modelSize.x.toFixed(2)},${this.weaponView.modelSize.y.toFixed(2)},${this.weaponView.modelSize.z.toFixed(2)} meshes=${(this.weaponView.meshNames || []).join(',')}`
            : '');
      }
    }
  }
}
