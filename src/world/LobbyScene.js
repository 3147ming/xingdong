/**
 * 3D 大厅：可第一人称漫游的基地空间
 *
 * 与战斗关卡完全隔离：独立 Scene + Camera + CollisionWorld。
 * 大厅里布置 9 处设施（作战指挥台 / 物资交易所 / 科研所 / 军械库 / 机甲库 /
 * 任务板 / 身体觉醒 / 战绩屏 / 设置终端），玩家走近后按 F 打开对应的 HTML 面板。
 *
 * 只负责 3D 表现、漫游与"最近设施"检测；DOM / 存档 / 面板切换全部由 Game 协调。
 */
import * as THREE from 'three';
import { CollisionWorld } from '../core/CollisionWorld.js';

/** 房间尺寸（米）：X 宽 22、Z 深 16、层高 4.6 */
const ROOM = { halfW: 11, halfD: 8, height: 4.6 };

/** 玩家漫游参数 */
const WALK = {
  speed: 4.4,
  sprintSpeed: 7.6,
  accel: 14,
  gravity: -18,
  radius: 0.32,
  height: 1.7,
  eye: 1.66,
  sens: 0.0022,
  interactDist: 3.0,
};

/**
 * 设施静态配置
 * - x / z：地面坐标
 * - face：屏幕朝向（0 = 朝 +Z，π/2 = 朝 +X，-π/2 = 朝 -X，π = 朝 -Z）
 * - tab：打开后对应的 HTML 页签
 * - special：差异化建模方式
 */
export const LOBBY_STATIONS = [
  { id: 'command', tab: 'battle', name: '作战指挥台', sub: 'COMMAND', color: 0xffb020, x: 0, z: -1.6, face: 0, special: 'command' },
  { id: 'exchange', tab: 'exchange', name: '物资交易所', sub: 'EXCHANGE', color: 0x35d07f, x: -6.8, z: -3.4, face: Math.PI / 2 },
  { id: 'research', tab: 'research', name: '科研所', sub: 'RESEARCH', color: 0x4aa8ff, x: -6.8, z: 0.9, face: Math.PI / 2, special: 'research' },
  { id: 'missions', tab: 'missions', name: '任务奖励', sub: 'MISSIONS', color: 0xff8a3d, x: -6.8, z: 4.8, face: Math.PI / 2, special: 'board' },
  { id: 'armory', tab: 'armory', name: '军械库', sub: 'ARMORY', color: 0xff5a2d, x: 6.8, z: -3.4, face: -Math.PI / 2, special: 'armory' },
  { id: 'mech', tab: 'mech', name: '机甲库', sub: 'MECHA', color: 0xb48cff, x: 6.8, z: 0.9, face: -Math.PI / 2, special: 'mech' },
  { id: 'talent', tab: 'talent', name: '身体觉醒', sub: 'AUGMENT', color: 0x35d0c0, x: 6.8, z: 4.8, face: -Math.PI / 2, special: 'pod' },
  { id: 'stats', tab: 'stats', name: '战绩统计', sub: 'RECORDS', color: 0x9ab4cc, x: 0, z: -7.35, face: 0, special: 'wallboard' },
  { id: 'settings', tab: 'settings', name: '设置', sub: 'SETTINGS', color: 0x8d9aa5, x: 5.4, z: 7.0, face: Math.PI },
];

export class LobbyScene {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202b38);
    this.scene.fog = new THREE.Fog(0x202b38, 22, 46);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 60);
    this.camera.rotation.order = 'YXZ';

    this.collision = new CollisionWorld();
    this.time = 0;
    this.spawn = new THREE.Vector3(0, 0, 6.6);
    this.player = {
      pos: this.spawn.clone(),
      vel: new THREE.Vector3(),
      yaw: 0,
      pitch: -0.04,
      bob: 0,
      moving: false,
    };

    this.stations = [];
    this.nearest = null;
    this._animated = [];        // 需要逐帧动画的发光 / 旋转对象
    this._tmpDir = new THREE.Vector3();

    this._buildLights();
    this._buildRoom();
    for (const def of LOBBY_STATIONS) this._buildStation(def);
    this._buildAmbientProps();

    this.resize();
    this._syncCamera(0);
  }

  // ==================== 构建：灯光 ====================
  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xb8cfe6, 0x2c3642, 3.0));

    const key = new THREE.DirectionalLight(0xfff0d6, 3.4);
    key.position.set(6, 12, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 36;
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 12;
    key.shadow.camera.bottom = -12;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.03;
    this.scene.add(key);

    // 顶灯：沿着大厅中轴排布，暖白偏黄，营造"车库基地"的氛围
    for (const z of [-5.2, -1.4, 2.4, 6.2]) {
      const lamp = new THREE.PointLight(0xffd9a0, 34, 20, 2);
      lamp.position.set(0, ROOM.height - 0.55, z);
      this.scene.add(lamp);
    }

    // 两侧冷色补光，把设施从暗部里托出来
    for (const sx of [-1, 1]) {
      const fill = new THREE.PointLight(0x3d7ab5, 16, 18, 2);
      fill.position.set(sx * 8.4, 3.4, 0);
      this.scene.add(fill);
    }

    // 入口背光：让玩家身后有轮廓光
    const back = new THREE.PointLight(0xff9436, 11, 14, 2);
    back.position.set(0, 2.6, 7.6);
    this.scene.add(back);
  }

  // ==================== 构建：房间 ====================
  _mat(color, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.28, ...extra });
  }

  _box(w, h, d, mat, x, y, z, parent = this.scene, opts = {}) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = opts.cast !== false;
    m.receiveShadow = opts.receive !== false;
    parent.add(m);
    return m;
  }

  /** 发光材质（灯带 / 屏幕） */
  _glow(color, intensity = 1.2, extra = {}) {
    return new THREE.MeshStandardMaterial({
      color: 0x0b0d10,
      emissive: color,
      emissiveIntensity: intensity,
      roughness: 0.4,
      metalness: 0.2,
      ...extra,
    });
  }

  _buildRoom() {
    const floorMat = this._mat(0x2e3a46, { roughness: 0.92, metalness: 0.12 });
    const wallMat = this._mat(0x46525e, { roughness: 0.85, metalness: 0.2 });
    const trimMat = this._mat(0x5c6a78, { roughness: 0.5, metalness: 0.55 });

    // 地板
    const floor = this._box(ROOM.halfW * 2, 0.3, ROOM.halfD * 2, floorMat, 0, -0.15, 0);
    floor.castShadow = false;

    // 中央圆形停机坪纹样
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3.4, 48),
      this._mat(0x26323e, { roughness: 0.8, metalness: 0.25, transparent: true, opacity: 0.9 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.005;
    disc.receiveShadow = true;
    this.scene.add(disc);

    const discRing = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.035, 8, 72), this._glow(0xffb020, 0.75));
    discRing.rotation.x = Math.PI / 2;
    discRing.position.y = 0.02;
    this.scene.add(discRing);
    this._animated.push({ mesh: discRing, kind: 'pulse', speed: 1.4, base: 0.75, amp: 0.25 });

    // 地面导引线：入口 → 指挥台，以及两侧设施区
    const guide = this._glow(0xffb020, 0.32, { transparent: true, opacity: 0.55 });
    const lineX = (z1, z2, x, w) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, Math.abs(z2 - z1)), guide);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.008, (z1 + z2) / 2);
      this.scene.add(m);
    };
    const lineZ = (x1, x2, z, w) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x2 - x1), w), guide);
      m.rotation.x = -Math.PI / 2;
      m.position.set((x1 + x2) / 2, 0.008, z);
      this.scene.add(m);
    };
    lineX(6.6, 0.6, 0, 0.12);
    lineZ(-6.8, -0.4, -1.6, 0.1);
    lineZ(0.4, 6.8, -1.6, 0.1);
    lineX(-1.6, -3.4, -6.8, 0.09);
    lineX(-1.6, -3.4, 6.8, 0.09);

    // 四面墙（预留 0.4m 厚度贴近房间边界）
    const wallT = 0.4;
    this._box(ROOM.halfW * 2, ROOM.height, wallT, wallMat, 0, ROOM.height / 2, -ROOM.halfD - wallT / 2, this.scene, { cast: false });
    this._box(ROOM.halfW * 2, ROOM.height, wallT, wallMat, 0, ROOM.height / 2, ROOM.halfD + wallT / 2, this.scene, { cast: false });
    this._box(wallT, ROOM.height, ROOM.halfD * 2, wallMat, -ROOM.halfW - wallT / 2, ROOM.height / 2, 0, this.scene, { cast: false });
    this._box(wallT, ROOM.height, ROOM.halfD * 2, wallMat, ROOM.halfW + wallT / 2, ROOM.height / 2, 0, this.scene, { cast: false });

    // 墙体碰撞（略向内收，避免贴脸穿模）
    this.collision.addBox(0, ROOM.height / 2, -ROOM.halfD - 0.2, ROOM.halfW * 2, ROOM.height, 0.4, 'lobby-wall');
    this.collision.addBox(0, ROOM.height / 2, ROOM.halfD + 0.2, ROOM.halfW * 2, ROOM.height, 0.4, 'lobby-wall');
    this.collision.addBox(-ROOM.halfW - 0.2, ROOM.height / 2, 0, 0.4, ROOM.height, ROOM.halfD * 2, 'lobby-wall');
    this.collision.addBox(ROOM.halfW + 0.2, ROOM.height / 2, 0, 0.4, ROOM.height, ROOM.halfD * 2, 'lobby-wall');

    // 墙顶 / 墙脚压条
    for (const z of [-ROOM.halfD, ROOM.halfD]) {
      this._box(ROOM.halfW * 2, 0.12, 0.12, trimMat, 0, ROOM.height - 0.1, z, this.scene, { cast: false });
      this._box(ROOM.halfW * 2, 0.1, 0.1, trimMat, 0, 0.05, z, this.scene, { cast: false });
    }
    for (const x of [-ROOM.halfW, ROOM.halfW]) {
      this._box(0.12, 0.12, ROOM.halfD * 2, trimMat, x, ROOM.height - 0.1, 0, this.scene, { cast: false });
      this._box(0.1, 0.1, ROOM.halfD * 2, trimMat, x, 0.05, 0, this.scene, { cast: false });
    }

    // 天花板
    this._box(ROOM.halfW * 2, 0.3, ROOM.halfD * 2, this._mat(0x333f4a, { roughness: 0.95, metalness: 0.1 }),
      0, ROOM.height + 0.15, 0, this.scene, { cast: false });

    // 天花横梁 + 灯管
    for (const z of [-5.2, -1.4, 2.4, 6.2]) {
      this._box(ROOM.halfW * 2 - 1.2, 0.22, 0.28, trimMat, 0, ROOM.height - 0.25, z, this.scene, { cast: false });
      this._box(ROOM.halfW * 2 - 2.4, 0.05, 0.12, this._glow(0xffe2b0, 1.5), 0, ROOM.height - 0.4, z, this.scene, { cast: false });
    }

    // 四周墙面灯带：低高度描边，弱光
    const strip = this._glow(0xff9436, 0.55);
    for (const z of [-ROOM.halfD + 0.06, ROOM.halfD - 0.06]) {
      this._box(ROOM.halfW * 2 - 0.6, 0.05, 0.04, strip, 0, ROOM.height - 0.32, z, this.scene, { cast: false });
    }
    for (const x of [-ROOM.halfW + 0.06, ROOM.halfW - 0.06]) {
      this._box(0.04, 0.05, ROOM.halfD * 2 - 0.6, strip, x, ROOM.height - 0.32, 0, this.scene, { cast: false });
    }

    // 立柱：四角 + 两侧中部，撑起基地结构感
    const pillarMat = this._mat(0x1c242d, { roughness: 0.6, metalness: 0.45 });
    for (const x of [-8.6, 8.6]) {
      for (const z of [-5.6, 0, 5.6]) {
        this._box(0.6, ROOM.height, 0.6, pillarMat, x, ROOM.height / 2, z);
        this.collision.addBox(x, ROOM.height / 2, z, 0.6, ROOM.height, 0.6, 'lobby-pillar');
        const band = this._box(0.66, 0.08, 0.66, this._glow(0xff9436, 0.5), x, 1.1, z, this.scene, { cast: false });
        band.receiveShadow = false;
      }
    }

    // 入口门框（z = +8 中段）：只是装饰，玩家不会走出去
    const frameMat = this._mat(0x2a333d, { roughness: 0.5, metalness: 0.6 });
    this._box(3.6, 0.3, 0.5, frameMat, 0, ROOM.height - 0.15, ROOM.halfD - 0.1, this.scene, { cast: false });
    this._box(0.3, ROOM.height, 0.5, frameMat, -1.8, ROOM.height / 2, ROOM.halfD - 0.1);
    this._box(0.3, ROOM.height, 0.5, frameMat, 1.8, ROOM.height / 2, ROOM.halfD - 0.1);
    this._box(3.9, 0.06, 0.06, this._glow(0xffb020, 0.9), 0, 2.9, ROOM.halfD - 0.34, this.scene, { cast: false });
  }

  // ==================== 构建：设施 ====================
  _buildStation(def) {
    const group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    group.rotation.y = def.face;
    this.scene.add(group);

    // 每处设施脚下的光区
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 32),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.10 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.012;
    group.add(pad);

    const padRing = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.022, 8, 48), this._glow(def.color, 0.8));
    padRing.rotation.x = Math.PI / 2;
    padRing.position.y = 0.02;
    group.add(padRing);
    this._animated.push({ mesh: padRing, kind: 'pulse', speed: 1.1 + Math.random() * 0.6, base: 0.8, amp: 0.25 });

    // 通用底座：设备柜 / 柜台
    const shellMat = this._mat(0x1e262f, { roughness: 0.55, metalness: 0.5 });
    const darkMat = this._mat(0x141a20, { roughness: 0.7, metalness: 0.35 });
    const screen = this._glow(def.color, 1.15);

    const special = def.special || 'desk';
    if (special === 'wallboard') {
      // 靠墙大屏：战绩统计
      this._box(4.4, 0.22, 0.5, shellMat, 0, 0.11, 0, group);
      this._box(4.2, 2.3, 0.18, darkMat, 0, 2.2, -0.1, group);
      const wallScreen = this._box(3.9, 1.9, 0.06, screen, 0, 2.25, 0.02, group);
      for (const sx of [-1.7, 0, 1.7]) this._box(1.0, 0.05, 0.05, this._glow(0x9ab4cc, 0.7), sx, 2.25, 0.06, group, { cast: false });
      this._animated.push({ mesh: wallScreen, kind: 'flicker', speed: 3.2 });
    } else if (special === 'board') {
      // 任务板：可读的立式大屏
      this._box(3.0, 0.16, 0.7, shellMat, 0, 0.08, 0, group);
      this._box(0.18, 2.1, 0.4, shellMat, -1.2, 1.05, 0, group);
      this._box(0.18, 2.1, 0.4, shellMat, 1.2, 1.05, 0, group);
      this._box(2.6, 1.55, 0.1, darkMat, 0, 1.7, 0, group);
      this._box(2.35, 1.3, 0.04, screen, 0, 1.72, 0.07, group);
      this._box(2.4, 0.05, 0.05, this._glow(def.color, 0.9), 0, 2.52, 0.08, group, { cast: false });
    } else if (special === 'command') {
      this._buildCommand(group, def);
    } else {
      // 通用：柜台 + 斜置屏幕 + 顶部光条 + 侧面柜体
      this._box(1.9, 0.95, 0.75, shellMat, 0, 0.475, 0, group);
      this._box(1.95, 0.06, 0.8, darkMat, 0, 0.97, 0, group);
      this._box(1.6, 0.1, 0.5, darkMat, 0, 1.0, -0.02, group);

      // 斜置终端屏
      const panel = this._box(1.5, 0.8, 0.07, screen, 0, 1.42, -0.18, group);
      panel.rotation.x = -0.32;
      // 屏幕外框
      this._box(1.62, 0.92, 0.05, darkMat, 0, 1.42, -0.21, group).rotation.x = -0.32;

      // 柜体灯带 + 侧面抽屉
      this._box(1.86, 0.04, 0.06, this._glow(def.color, 0.9), 0, 0.16, 0.39, group, { cast: false });
      this._box(1.86, 0.04, 0.06, this._glow(def.color, 0.9), 0, 0.86, 0.39, group, { cast: false });
      this._box(0.5, 0.34, 0.42, darkMat, -0.58, 0.74, 0.32, group);
      this._box(0.5, 0.34, 0.42, darkMat, 0.58, 0.74, 0.32, group);

      if (special === 'research') this._decorResearch(group, def);
      if (special === 'armory') this._decorArmory(group, def);
      if (special === 'mech') this._decorMech(group, def);
      if (special === 'pod') this._decorPod(group, def);
    }

    // 碰撞：以设施中心为基准的一圈不可穿越体积
    const halfDepth = def.special === 'wallboard' ? 0.4 : 0.55;
    this.collision.addBox(def.x, 0.9, def.z, 1.9, 1.8, halfDepth * 2 + 0.4, 'lobby-station');

    // 悬浮名牌
    this._addLabel(group, def);
    this.stations.push({ def, group });
  }

  /** 指挥台：圆形基座 + 全息沙盘 */
  _buildCommand(group, def) {
    const shellMat = this._mat(0x1e262f, { roughness: 0.55, metalness: 0.5 });
    const darkMat = this._mat(0x12181e, { roughness: 0.6, metalness: 0.4 });

    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.7, 0.5, 40), shellMat);
    base.position.y = 0.25;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const top = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.42, 0.06, 40), darkMat);
    top.position.y = 0.53;
    top.receiveShadow = true;
    group.add(top);

    // 全息沙盘：半透明圆盘 + 旋转扫描线 + 悬浮方块
    const holoMat = new THREE.MeshBasicMaterial({
      color: def.color, transparent: true, opacity: 0.20, side: THREE.DoubleSide, depthWrite: false,
    });
    const holo = new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), holoMat);
    holo.rotation.x = -Math.PI / 2;
    holo.position.y = 1.05;
    group.add(holo);
    this._animated.push({ mesh: holo, kind: 'spin', speed: 0.35 });

    const sweep = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 1.15, 40, 1, 0, Math.PI / 4),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
    );
    sweep.rotation.x = -Math.PI / 2;
    sweep.position.y = 1.06;
    group.add(sweep);
    this._animated.push({ mesh: sweep, kind: 'spin', speed: -0.9 });

    const holoRing = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.02, 8, 48), this._glow(def.color, 1.4));
    holoRing.rotation.x = Math.PI / 2;
    holoRing.position.y = 1.05;
    group.add(holoRing);

    // 沙盘上的三块领地模型（对应三种作战模式）
    const capMat = this._glow(def.color, 0.9);
    for (const [i, z] of [-0.42, 0, 0.42].entries()) {
      const blk = this._box(0.26 + i * 0.08, 0.16, 0.26 + i * 0.08, capMat, -0.55 + i * 0.16, 1.15, z, group, { cast: false });
      this._animated.push({ mesh: blk, kind: 'bob', speed: 1.2 + i * 0.4, base: 1.15, amp: 0.05 });
    }

    // 台边操作面板
    this._box(0.5, 0.04, 0.34, this._glow(def.color, 0.7), 0.95, 0.56, 0.9, group, { cast: false });
    this._box(0.5, 0.04, 0.34, this._glow(def.color, 0.7), -0.95, 0.56, 0.9, group, { cast: false });
  }

  _decorResearch(group, def) {
    // 全息分子：三层旋转圆环
    const mat = this._glow(def.color, 1.1);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), mat);
    core.position.set(-1.35, 1.5, 0.1);
    group.add(core);
    this._animated.push({ mesh: core, kind: 'bob', speed: 1.6, base: 1.5, amp: 0.08 });
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32 + i * 0.08, 0.012, 6, 40),
        this._glow(def.color, 0.7, { transparent: true, opacity: 0.85 }));
      ring.position.set(-1.35, 1.5, 0.1);
      ring.rotation.set(i * 0.9, i * 0.6, i * 0.4);
      group.add(ring);
      this._animated.push({ mesh: ring, kind: 'orbit', speed: 0.35 + i * 0.18, axis: i });
    }
    // 试管架
    for (let i = 0; i < 4; i++) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8),
        this._glow(def.color, 0.6 + i * 0.1));
      tube.position.set(0.55 + i * 0.11, 1.1, 0.2);
      group.add(tube);
    }
  }

  _decorArmory(group, def) {
    // 后方枪架 + 三支简模步枪
    const metal = this._mat(0x7d8996, { roughness: 0.35, metalness: 0.8 });
    const dark = this._mat(0x232c36, { roughness: 0.6, metalness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const rifle = new THREE.Group();
      rifle.position.set(-0.5 + i * 0.5, 1.75, -0.55);
      rifle.rotation.set(0.1, 0, Math.PI / 2 - 0.2);
      group.add(rifle);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.09, 0.11), metal);
      rifle.add(body);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.09), dark);
      mag.position.set(-0.1, -0.13, 0);
      rifle.add(mag);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.1), dark);
      stock.position.set(-0.52, -0.02, 0);
      rifle.add(stock);
    }
    // 工作台夹具
    this._box(0.3, 0.08, 0.24, dark, 0.55, 1.02, 0.15, group);
    this._box(0.08, 0.18, 0.08, metal, 0.55, 1.12, 0.15, group);
  }

  _decorMech(group, def) {
    // 机甲舱：高大的停机架 + 内部发光人形轮廓
    const frameMat = this._mat(0x1a222a, { roughness: 0.5, metalness: 0.6 });
    for (const sx of [-1, 1]) {
      this._box(0.22, 3.2, 0.5, frameMat, sx * 0.95, 1.6, -0.45, group);
    }
    this._box(2.4, 0.24, 0.6, frameMat, 0, 3.2, -0.45, group);
    this._box(2.05, 2.7, 0.14, this._glow(def.color, 0.28, { transparent: true, opacity: 0.5 }), 0, 1.6, -0.62, group, { cast: false });
    this._box(0.9, 1.25, 0.24, this._glow(def.color, 0.9), 0, 1.55, -0.5, group, { cast: false });
    this._box(0.45, 0.4, 0.26, this._glow(def.color, 1.1), 0, 2.32, -0.5, group, { cast: false });
    this._box(2.2, 0.06, 0.06, this._glow(def.color, 0.9), 0, 0.35, 0.2, group, { cast: false });
  }

  _decorPod(group, def) {
    // 觉醒舱：立式培养舱 + 内部上升的液面光
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0d1a1e, emissive: def.color, emissiveIntensity: 0.22,
      transparent: true, opacity: 0.55, roughness: 0.15, metalness: 0.4,
    });
    const shellMat = this._mat(0x1e262f, { roughness: 0.55, metalness: 0.5 });
    this._box(0.9, 0.3, 0.9, shellMat, 0.15, 0.15, -0.35, group);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 2.3, 24), glass);
    cyl.position.set(0.15, 1.4, -0.35);
    cyl.castShadow = true;
    group.add(cyl);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.46, 0.24, 24), shellMat);
    cap.position.set(0.15, 2.6, -0.35);
    group.add(cap);
    const fluid = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.9, 20), this._glow(def.color, 1.4, { transparent: true, opacity: 0.7 }));
    fluid.position.set(0.15, 1.0, -0.35);
    group.add(fluid);
    this._animated.push({ mesh: fluid, kind: 'bob', speed: 0.8, base: 1.0, amp: 0.18 });
  }

  /** 悬浮名牌：Canvas 纹理 + Sprite，始终面向相机 */
  _addLabel(group, def) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const g = canvas.getContext('2d');
    const hex = '#' + new THREE.Color(def.color).getHexString();

    g.clearRect(0, 0, canvas.width, canvas.height);
    // 半透明底板 + 色条
    g.fillStyle = 'rgba(8, 12, 16, 0.82)';
    g.fillRect(6, 10, canvas.width - 12, canvas.height - 20);
    g.fillStyle = hex;
    g.fillRect(6, 10, 6, canvas.height - 20);
    g.fillStyle = '#e8eef2';
    g.font = '700 54px "Microsoft YaHei", "PingFang SC", sans-serif';
    g.textBaseline = 'middle';
    g.fillText(def.name, 30, 66);
    g.fillStyle = hex;
    g.font = '500 26px Consolas, "Courier New", monospace';
    g.fillText(def.sub, 31, 118);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(1.95, 0.61, 1);
    sprite.position.set(0, 2.72, 0.1);
    group.add(sprite);
    this._animated.push({ mesh: sprite, kind: 'float', speed: 1.0, base: 2.72, amp: 0.045 });
  }

  /** 场景点缀：货箱、油桶、地面警示标 */
  _buildAmbientProps() {
    const crateMat = this._mat(0x24303a, { roughness: 0.9, metalness: 0.15 });
    const crateWarn = this._mat(0x3a2a14, { roughness: 0.9, metalness: 0.1 });
    const y = 0.3;
    const crates = [
      [-9.6, -6.2], [-9.0, -6.8], [-9.6, 6.4], [9.6, -6.4], [9.0, 6.2], [-4.2, 6.9],
    ];
    for (const [x, z] of crates) {
      const s = 0.6 + Math.random() * 0.2;
      this._box(s, s, s, crateMat, x, s / 2, z);
      this.collision.addBox(x, s / 2, z, s, s, s, 'lobby-crate');
      if (Math.random() < 0.5) {
        this._box(s * 0.9, 0.04, 0.04, crateWarn, x, s + 0.02, z, this.scene, { cast: false });
      }
    }
    // 后墙两侧油桶
    const barrelMat = this._mat(0x2c2418, { roughness: 0.8, metalness: 0.3 });
    for (const x of [-3.4, 3.4]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.92, 16), barrelMat);
      barrel.position.set(x, 0.46, -7.2);
      barrel.castShadow = true;
      barrel.receiveShadow = true;
      this.scene.add(barrel);
      this.collision.addBox(x, 0.46, -7.2, 0.64, 0.92, 0.64, 'lobby-barrel');
    }
  }

  // ==================== 运行 ====================
  /** 重置到出生点（每次回到大厅调用） */
  resetPlayer() {
    this.player.pos.copy(this.spawn);
    this.player.vel.set(0, 0, 0);
    this.player.yaw = 0;
    this.player.pitch = -0.04;
    this.player.bob = 0;
    this._syncCamera(0);
  }

  /**
   * @param {number} dt
   * @param {import('../core/Input.js').Input} input
   * @returns {{def:{id:string,name:string,tier:string}}|null} 当前可交互设施
   */
  update(dt, input) {
    this.time += dt;
    this._move(dt, input);
    this._animate();
    this.nearest = this._findNearest();
    return this.nearest;
  }

  _move(dt, input) {
    const p = this.player;
    const d = input.consumeMouseDelta();
    p.yaw -= d.x * WALK.sens;
    p.pitch = Math.max(-1.15, Math.min(1.15, p.pitch - d.y * WALK.sens));

    const forward = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));

    const ix = (input.actionDown('right') ? 1 : 0) - (input.actionDown('left') ? 1 : 0);
    const iz = (input.actionDown('forward') ? 1 : 0) - (input.actionDown('backward') ? 1 : 0);
    let dirX = right.x * ix + forward.x * iz;
    let dirZ = right.z * ix + forward.z * iz;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1) { dirX /= len; dirZ /= len; }

    const sprint = input.actionDown('sprint') && len > 0;
    const speed = sprint ? WALK.sprintSpeed : WALK.speed;

    const k = Math.min(1, WALK.accel * dt);
    p.vel.x += (dirX * speed - p.vel.x) * k;
    p.vel.z += (dirZ * speed - p.vel.z) * k;
    p.vel.y += WALK.gravity * dt;

    this.collision.moveCharacter(p.pos, p.vel, dt, WALK.radius, WALK.height);

    // 走动时的轻微镜头起伏
    const hSpeed = Math.hypot(p.vel.x, p.vel.z);
    p.moving = hSpeed > 0.6;
    if (p.moving) p.bob += dt * (sprint ? 12 : 8);
    p.bob = p.moving ? p.bob : 0;

    this._syncCamera(hSpeed > 0.6 ? Math.sin(p.bob) * 0.012 * Math.min(1, hSpeed / 4) : 0);
  }

  _syncCamera(bob) {
    this.camera.position.set(this.player.pos.x, this.player.pos.y + WALK.eye + bob, this.player.pos.z);
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0, 'YXZ');
  }

  /** 距离最近、且大致位于玩家前方 / 身侧的设施 */
  _findNearest() {
    let best = null;
    for (const s of this.stations) {
      const dx = s.def.x - this.player.pos.x;
      const dz = s.def.z - this.player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > WALK.interactDist) continue;
      if (!best || dist < best.dist) best = { def: s.def, dist };
    }
    return best;
  }

  _animate() {
    const t = this.time;
    for (const a of this._animated) {
      const m = a.mesh;
      if (a.kind === 'pulse') {
        m.material.emissiveIntensity = a.base + Math.sin(t * a.speed) * a.amp;
      } else if (a.kind === 'spin') {
        m.rotation.z += a.speed * 0.016;
      } else if (a.kind === 'bob') {
        m.position.y = a.base + Math.sin(t * a.speed) * a.amp;
      } else if (a.kind === 'float') {
        m.position.y = a.base + Math.sin(t * a.speed + 1.2) * a.amp;
      } else if (a.kind === 'orbit') {
        const ax = a.axis;
        m.rotation.x += a.speed * 0.016 * (ax % 2 ? 1 : -1);
        m.rotation.y += a.speed * 0.012;
      } else if (a.kind === 'flicker') {
        m.material.emissiveIntensity = 0.7 + Math.sin(t * 6) * 0.06 + Math.sin(t * 23) * 0.03;
      }
    }
  }

  /** 仅推进演出动画（打开面板时调用，不处理移动与输入） */
  tick(dt) {
    this.time += dt;
    this._animate();
  }

  resize() {
    this.camera.aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
    this.camera.updateProjectionMatrix();
  }

  render(renderer) {
    renderer.render(this.scene, this.camera);
  }
}
