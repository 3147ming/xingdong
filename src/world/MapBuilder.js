/**
 * 地图构建器（P1）
 *
 * 把原本写死在 OutdoorMap 里的图元拼装逻辑抽成「布局参数 → 场景」，
 * 这样 5 个关卡只需要各自一份 layouts 数据，不用再为每张图写一套构建代码，
 * 也不需要新增任何 3D 美术资源。
 *
 * 所有可调内容都在 layout 对象里：
 * 场地尺寸 / 天空雾效 / 光照 / 地面材质 / 掩体数组 / 出生点 / 巡逻点。
 */
import * as THREE from 'three';
import { PLAYER, ENEMY } from '../config/weapon.js';

/** 用 Canvas 生成纹理，避免额外网络请求 */
function canvasTexture(size, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  return t;
}

/**
 * 程序化多倍频噪声高度场（0..1，可无缝平铺）。
 * 用 5 个八度的值噪声双线性插值叠加，比纯随机点更接近混凝土 / 沥青的真实颗粒。
 * 法线图与粗糙度图都从这同一份高度场派生，保证三张图细节对得上。
 */
function heightField(size = 256) {
  const data = new Float32Array(size * size);
  const octaves = [[4, 0.40], [8, 0.26], [16, 0.16], [32, 0.11], [64, 0.07]];
  for (const [cells, weight] of octaves) {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * cells;
      const y0 = Math.floor(gy);
      const y1 = (y0 + 1) % cells;
      const ty = gy - y0;
      const row0 = y0 * cells;
      const row1 = y1 * cells;
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const x0 = Math.floor(gx);
        const x1 = (x0 + 1) % cells;
        const tx = gx - x0;
        const a = grid[row0 + x0];
        const b = grid[row0 + x1];
        const c = grid[row1 + x0];
        const d = grid[row1 + x1];
        const top = a + (b - a) * tx;
        const bot = c + (d - c) * tx;
        data[y * size + x] += (top + (bot - top) * ty) * weight;
      }
    }
  }
  return data;
}

/**
 * 高度场 → 切线空间法线图（Sobel 求梯度）。
 * 这是参考作里最有效的纹理技法：一张灰度噪声就能换来真实的掠射高光与凹凸感，
 * 比 bumpMap 更准确（bumpMap 只用一阶差分近似）。
 */
function normalTextureFromHeight(data, size, strength = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => data[((y + size) % size) * size + ((x + size) % size)];
  const k = strength * size / 256 * 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * k;
      const dy = (at(x, y - 1) - at(x, y + 1)) * k;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;   // 法线图必须是线性数据，不能当 sRGB 解码
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * 高度场 → 粗糙度图：凹处更粗糙、凸起被磨得更光。
 * 结果落在 base ± contrast，避免整面墙都是同一个粗糙度而显得塑料。
 */
function roughnessTextureFromHeight(data, size, base = 0.9, contrast = 0.18) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const span = Math.max(1e-4, max - min);
  for (let i = 0; i < data.length; i++) {
    const h = (data[i] - min) / span;
    const v = Math.max(0, Math.min(1, base + (0.5 - h) * contrast * 2));
    const p = i * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = Math.round(v * 255);
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;   // 粗糙度图同样是线性数据
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 天空渐变（用作 scene.background） */
function skyGradientTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#' + top.toString(16).padStart(6, '0'));
  g.addColorStop(1, '#' + bottom.toString(16).padStart(6, '0'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 沥青地面 */
function asphaltTexture(rx, ry) {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#43474c';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 14000; i++) {
      const v = 52 + Math.random() * 42;
      ctx.fillStyle = `rgba(${v},${v},${v + 3},${Math.random() * 0.22})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, Math.random() * 4, Math.random() * 4);
    }
    // 裂纹
    for (let i = 0; i < 10; i++) {
      ctx.strokeStyle = 'rgba(22,24,26,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let x = Math.random() * s, y = Math.random() * s;
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (Math.random() - 0.5) * 60;
        y += (Math.random() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 油渍：径向渐变的暗斑，边缘柔和
    for (let i = 0; i < 16; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      const r = 12 + Math.random() * 46;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(12,14,16,${0.28 + Math.random() * 0.22})`);
      g.addColorStop(0.7, 'rgba(14,16,18,0.16)');
      g.addColorStop(1, 'rgba(14,16,18,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // 轮胎印：两条平行的暗色磨痕
    for (let i = 0; i < 4; i++) {
      const y = Math.random() * s;
      ctx.strokeStyle = `rgba(18,19,21,${0.18 + Math.random() * 0.12})`;
      ctx.lineWidth = 6 + Math.random() * 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s, y + (Math.random() - 0.5) * 30);
      ctx.stroke();
      ctx.lineWidth = 5 + Math.random() * 3;
      ctx.beginPath();
      ctx.moveTo(0, y + 22);
      ctx.lineTo(s, y + 22 + (Math.random() - 0.5) * 30);
      ctx.stroke();
    }
    // 积水：偏冷色的暗亮斑，边缘有反光感
    for (let i = 0; i < 6; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      const r = 10 + Math.random() * 30;
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
      g.addColorStop(0, 'rgba(96,112,124,0.30)');
      g.addColorStop(0.75, 'rgba(60,72,82,0.22)');
      g.addColorStop(1, 'rgba(60,72,82,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.45 + Math.random() * 0.4), Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }, rx, ry);
}

/** 混凝土地面（车库 / 码头硬化地） */
function concreteFloorTexture(rx, ry) {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#565a5e';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const v = 66 + Math.random() * 48;
      ctx.fillStyle = `rgba(${v},${v + 2},${v + 4},${Math.random() * 0.2})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    // 伸缩缝
    ctx.strokeStyle = 'rgba(32,35,38,0.5)';
    ctx.lineWidth = 3;
    for (let p = 0; p <= s; p += 170) {
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
    }
  }, rx, ry);
}

/** 泥土 / 荒地面（物流园区） */
function dirtTexture(rx, ry) {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#5b5344';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 12000; i++) {
      const v = 62 + Math.random() * 52;
      ctx.fillStyle = `rgba(${v},${v - 6},${v - 16},${Math.random() * 0.24})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 4, 1 + Math.random() * 4);
    }
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(${30 + Math.random() * 30},${28 + Math.random() * 26},${24 + Math.random() * 20},0.35)`;
      ctx.beginPath();
      ctx.arc(Math.random() * s, Math.random() * s, 2 + Math.random() * 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }, rx, ry);
}

/** 混凝土（矮墙 / 基座） */
function concreteTexture() {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#6a6e72';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 8000; i++) {
      const v = 82 + Math.random() * 55;
      ctx.fillStyle = `rgba(${v},${v + 3},${v + 6},${Math.random() * 0.22})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    ctx.strokeStyle = 'rgba(40,43,46,0.4)';
    ctx.lineWidth = 2;
    for (let y = 0; y <= s; y += 128) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
    }
  }, 4, 1);
}

/** 纸箱纸板纹理 */
function cardboardTexture() {
  return canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#9c7648';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 1600; i++) {
      const a = Math.random() * 0.18;
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? 60 : 190},${120 + Math.random() * 60},70,${a})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 2);
    }
    ctx.fillStyle = 'rgba(214,199,160,0.55)';
    ctx.fillRect(s * 0.42, 0, s * 0.16, s);
    ctx.fillStyle = 'rgba(235,232,220,0.75)';
    ctx.fillRect(s * 0.1, s * 0.68, s * 0.24, s * 0.16);
    ctx.strokeStyle = 'rgba(80,60,40,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(s * 0.1, s * 0.68, s * 0.24, s * 0.16);
    ctx.fillStyle = 'rgba(60,45,30,0.65)';
    for (let i = 0; i < 3; i++) ctx.fillRect(s * 0.12, s * 0.71 + i * 8, s * 0.16, 2);
  });
}

/** 任意尺寸灰度画布 → 切线空间法线图（Sobel，环绕采样） */
function normalTextureFromCanvas(srcCanvas, strength = 1) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const at = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  const k = strength * 6.0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * k;
      const dy = (at(x, y - 1) - at(x, y + 1)) * k;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 集装箱加强筋 + 锈蚀凹凸图：竖向瓦楞在平行光下有可读的体积感 */
function containerBumpTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 256, 128);
  for (let x = 0; x < 256; x += 16) {
    const g = ctx.createLinearGradient(x, 0, x + 16, 0);
    g.addColorStop(0, '#9c9c9c');
    g.addColorStop(0.45, '#656565');
    g.addColorStop(0.55, '#5e5e5e');
    g.addColorStop(1, '#909090');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 16, 128);
  }
  // 锈斑与磕碰：随机亮暗小斑块
  for (let i = 0; i < 260; i++) {
    const v = Math.random() < 0.5 ? 44 : 208;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.10 + Math.random() * 0.26})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 128, 1 + Math.random() * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const FLOOR_STYLES = {
  asphalt: asphaltTexture,
  concrete: concreteFloorTexture,
  dirt: dirtTexture,
};

const DEFAULT_LIGHTS = {
  hemiSky: 0xbcd4ea,
  hemiGround: 0x4a4234,
  hemiIntensity: 1.15,
  sunColor: 0xffeed2,
  sunIntensity: 2.8,
  sunPos: [-30, 42, 22],
  fillColor: 0x7fa4cc,
  fillIntensity: 0.8,
  fillPos: [22, 16, -28],
  ambientColor: 0x6c7784,
  ambientIntensity: 0.8,
};

export class MapBuilder {
  /**
   * @param {THREE.Scene} scene
   * @param {CollisionWorld} collision
   * @param {object} assets
   * @param {object} layout 见 src/world/levels.js
   */
  constructor(scene, collision, assets, layout) {
    this.scene = scene;
    this.collision = collision;
    this.assets = assets;
    this.layout = layout;
    this.group = new THREE.Group();
    this.sceneObjects = [];   // 直接挂在 scene 上的灯光，切换地图时一并移除
    this.barrels = [];        // 可爆炸物：油桶位置
    this.cars = [];           // 可爆炸物：汽车位置

    const spawn = layout.startPos || PLAYER.startPos;
    this.playerSpawn = new THREE.Vector3(spawn.x, spawn.y || 0, spawn.z);
    const patrol = layout.patrolPoints || ENEMY.patrolPoints;
    this.waypoints = patrol.map((p) => new THREE.Vector3(p.x, 0, p.z));
    const spawnPts = layout.spawnPoints || ENEMY.spawnPoints;
    this.spawnPoints = spawnPts.map((p) => new THREE.Vector3(p.x, 0, p.z));

    // 统一从同一份高度场派生「法线图 + 粗糙度图」：三张图细节对得上，
    // 平行光掠射时能看出骨料颗粒与磨损，而不是一块平贴图。
    const surfaceMaps = (size = 256, normalStrength = 1, roughBase = 0.9, roughContrast = 0.18) => {
      const h = heightField(size);
      return {
        normalMap: normalTextureFromHeight(h, size, normalStrength),
        roughnessMap: roughnessTextureFromHeight(h, size, roughBase, roughContrast),
      };
    };

    const concreteMaps = surfaceMaps(256, 0.85, 0.94, 0.16);
    concreteMaps.normalMap.repeat.set(4, 1);   // 与混凝土贴图 repeat 对齐，避免拉伸
    concreteMaps.roughnessMap.repeat.set(4, 1);
    this.matConcrete = new THREE.MeshStandardMaterial({
      map: concreteTexture(),
      normalMap: concreteMaps.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: concreteMaps.roughnessMap,
      roughness: 1.0, metalness: 0.04,
    });
    const cardboardMaps = surfaceMaps(256, 0.55, 0.88, 0.1);
    this.matCardboard = new THREE.MeshStandardMaterial({
      map: cardboardTexture(),
      normalMap: cardboardMaps.normalMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughnessMap: cardboardMaps.roughnessMap,
      roughness: 1.0, metalness: 0.0,
    });
    this.matMetal = new THREE.MeshStandardMaterial({
      color: 0x5a6068, roughness: 0.55, metalness: 0.55,
    });
    this.matBeam = new THREE.MeshStandardMaterial({
      color: 0x3c424a, roughness: 0.7, metalness: 0.35,
    });
    this.matFence = new THREE.MeshStandardMaterial({
      color: 0x707a82, roughness: 0.6, metalness: 0.5,
    });
    this.matSilhouette = new THREE.MeshStandardMaterial({
      color: layout.silhouetteColor != null ? layout.silhouetteColor : 0x8fa2b4,
      roughness: 1.0, metalness: 0.0,
    });

    const w = layout.halfX * 2;
    const d = layout.halfZ * 2;
    const style = FLOOR_STYLES[layout.floorStyle] || asphaltTexture;
    const floorMap = style(Math.max(4, Math.round(w / 4.6)), Math.max(3, Math.round(d / 4.4)));
    const floorMaps = surfaceMaps(256, 0.7, 0.95, 0.2);
    floorMaps.normalMap.repeat.copy(floorMap.repeat);
    floorMaps.roughnessMap.repeat.copy(floorMap.repeat);
    this.matFloor = new THREE.MeshStandardMaterial({
      map: floorMap,
      normalMap: floorMaps.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: floorMaps.roughnessMap,
      color: layout.floorTint != null ? layout.floorTint : 0xffffff,
      roughness: 1.0, metalness: 0.02,
    });
  }

  build() {
    this._buildSky();
    this._buildFloor();
    this._buildMainRoad();
    this._buildCeiling();
    this._buildPerimeter();
    this._buildBuildings();          // 建筑 / 据点（新增）
    this._buildCrates();
    this._buildShelves();
    this._buildContainers();
    this._buildProps();
    this._buildPillars();
    this._buildSilhouettes();
    this._buildLights();
    // 出生点 / 巡逻点修正：落在不可进入的碰撞体（建筑内部等）会被挪到最近的空地
    this._resolveNavigationPoints();
    this.group.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
    this.scene.add(this.group);

    // 汇总所有可爆炸物供 ExplosionSystem 注册
    this.explodables = this.barrels.map((b) => ({ ...b, tag: 'barrel' }))
      .concat(this.cars.map((c) => ({ ...c, tag: 'car' })));

    return this;
  }

  // ---------------- 天空 ----------------
  _buildSky() {
    const L = this.layout;
    const sky = L.sky || {};
    this.scene.background = skyGradientTexture(
      sky.top != null ? sky.top : 0x9fc0dd,
      sky.bottom != null ? sky.bottom : 0xe3e8e6
    );
    this.scene.fog = new THREE.Fog(
      sky.fogColor != null ? sky.fogColor : 0xc8d2d8,
      sky.fogNear != null ? sky.fogNear : 30,
      sky.fogFar != null ? sky.fogFar : 120
    );
  }

  // ---------------- 地面 ----------------
  _buildFloor() {
    const w = this.layout.halfX * 2;
    const d = this.layout.halfZ * 2;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 1, 1), this.matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    floor.receiveShadow = true;
    this.group.add(floor);
    this.collision.addBox(0, -0.5, 0, w, 1, d, 'floor');
  }

  // ---------------- 主路：贯穿场地的主干道（纯视觉，不参与碰撞） ----------------
  _buildMainRoad() {
    const road = this.layout.mainRoad;
    if (!road) return;
    const w = road.w != null ? road.w : 6;
    const d = road.d != null ? road.d : this.layout.halfZ * 2;
    const group = new THREE.Group();
    group.name = 'main-road';
    group.position.set(road.x || 0, 0, road.z || 0);
    group.rotation.y = road.rot || 0;

    // 沥青路面（略高于地面，避免与地面纹理 z-fighting）
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: 0x2c2e31, roughness: 0.98, metalness: 0.03 })
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0.012;
    surface.receiveShadow = true;
    group.add(surface);

    // 中央黄色虚线
    const dashGeo = new THREE.PlaneGeometry(0.16, 2);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xe0bd46 });
    for (let z = -d / 2 + 2; z < d / 2 - 1; z += 4) {
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(0, 0.018, z);
      group.add(dash);
    }

    // 两侧边线
    const edgeGeo = new THREE.PlaneGeometry(0.12, d);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xd6d6d0 });
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(edgeGeo, edgeMat);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(side * (w / 2 - 0.22), 0.016, 0);
      group.add(edge);
    }

    this.group.add(group);
  }

  // ---------------- 天花板（地下车库等室内图） ----------------
  _buildCeiling() {
    const c = this.layout.ceiling;
    if (!c) return;
    const w = this.layout.halfX * 2;
    const d = this.layout.halfZ * 2;
    const y = c.y != null ? c.y : 4.6;
    const mat = new THREE.MeshStandardMaterial({
      color: c.color != null ? c.color : 0x30343a,
      roughness: 0.95, metalness: 0.05, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = Math.PI / 2;
    m.position.set(0, y, 0);
    this.group.add(m);
  }

  // ---------------- 边界：视觉围栏 + 隐形高墙 ----------------
  _buildPerimeter() {
    const L = this.layout;
    const x = L.halfX;
    const z = L.halfZ;
    const fh = L.fenceHeight != null ? L.fenceHeight : 1.55;
    const wh = L.wallHeight != null ? L.wallHeight : 8;

    // 隐形边界高墙（碰撞用，不可见）
    const inv = (cx, cy, cz, sx, sy, sz) => this.collision.addBox(cx, cy, cz, sx, sy, sz, 'wall');
    inv(0, wh / 2, -z, x * 2 + 2, wh, 1);
    inv(0, wh / 2, z, x * 2 + 2, wh, 1);
    inv(-x, wh / 2, 0, 1, wh, z * 2 + 2);
    inv(x, wh / 2, 0, 1, wh, z * 2 + 2);

    // 视觉围栏：柱 + 两道横杆（低矮，抬头可见天空）
    // P1：柱与横杆改用 InstancedMesh，把几十个 draw call 压成 2 个
    const postGeo = new THREE.BoxGeometry(0.12, fh, 0.12);
    const railGeo = new THREE.BoxGeometry(1, 0.06, 0.06);
    const dummy = new THREE.Object3D();

    const posts = [];
    for (let px = -x; px <= x; px += 4) posts.push([px, -z], [px, z]);
    for (let pz = -z; pz <= z; pz += 4) posts.push([-x, pz], [x, pz]);
    const postMesh = new THREE.InstancedMesh(postGeo, this.matFence, posts.length);
    posts.forEach(([px, pz], i) => {
      dummy.position.set(px, fh / 2, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      postMesh.setMatrixAt(i, dummy.matrix);
    });
    postMesh.instanceMatrix.needsUpdate = true;
    postMesh.castShadow = true;
    postMesh.frustumCulled = false;   // 实例分布的包围盒靠几何体算不准，关掉剔除更稳
    this.group.add(postMesh);

    const rails = [];
    const addRail = (x0, z0, x1, z1, y) => rails.push({ x0, z0, x1, z1, y });
    for (const y of [fh * 0.45, fh * 0.85]) {
      addRail(-x, -z, x, -z, y);
      addRail(-x, z, x, z, y);
      addRail(-x, -z, -x, z, y);
      addRail(x, -z, x, z, y);
    }
    const railMesh = new THREE.InstancedMesh(railGeo, this.matFence, rails.length);
    rails.forEach((r, i) => {
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
      dummy.position.set((r.x0 + r.x1) / 2, r.y, (r.z0 + r.z1) / 2);
      dummy.rotation.set(0, Math.atan2(r.z1 - r.z0, r.x1 - r.x0), 0);
      dummy.scale.set(len, 1, 1);
      dummy.updateMatrix();
      railMesh.setMatrixAt(i, dummy.matrix);
    });
    railMesh.instanceMatrix.needsUpdate = true;
    railMesh.castShadow = true;
    railMesh.frustumCulled = false;
    this.group.add(railMesh);

    // 混凝土矮墙段（带缺口，做掩体也做视觉边界）
    const segs = L.perimeterSegs || [];
    for (const [cx, cz, sx, sz] of segs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.15, sz), this.matConcrete);
      m.position.set(cx, 0.575, cz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.collision.addBox(cx, 0.575, cz, sx, 1.15, sz, 'wall');
    }
  }

  // ---------------- 纸箱掩体 ----------------
  _buildCrates() {
    const crates = this.layout.crates || [];
    let idx = 0;
    for (const c of crates) {
      const baseY = c.onTop ? (c.baseY != null ? c.baseY : 1.4) : (c.baseY || 0);
      this._addCrate(c.x, c.z, c.w, c.h, c.d, baseY, idx++);
    }
  }

  _addCrate(x, z, w, h, d, baseY = 0, seed = 0) {
    let mesh;
    const models = this.assets && this.assets.boxes;
    if (models && models.length > 0) {
      const src = models[seed % models.length];
      mesh = src.clone(true);
      const box0 = new THREE.Box3().setFromObject(mesh);
      const size = box0.getSize(new THREE.Vector3());
      const s = Math.min(w / Math.max(size.x, 0.001), h / Math.max(size.y, 0.001), d / Math.max(size.z, 0.001));
      mesh.scale.setScalar(s);
      const box1 = new THREE.Box3().setFromObject(mesh);
      mesh.position.set(
        x - (box1.min.x + box1.max.x) / 2,
        baseY - box1.min.y,
        z - (box1.min.z + box1.max.z) / 2
      );
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.material = this.matCardboard;
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = true;
        }
      });
      mesh.rotation.y = (Math.random() - 0.5) * 0.35;
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.matCardboard);
      mesh.position.set(x, baseY + h / 2, z);
    }

    this.group.add(mesh);
    this.collision.addBox(x, baseY + h / 2, z, w + 0.06, h, d + 0.06, 'crate');
  }

  // ---------------- 货架 ----------------
  _buildShelves() {
    const racks = this.layout.racks || [];
    if (racks.length === 0) return;
    // P1：货架体与层板都改为 InstancedMesh（单位立方体 + 逐实例缩放）
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();

    const bodyMesh = new THREE.InstancedMesh(unit, this.matMetal, racks.length);
    racks.forEach((r, i) => {
      dummy.position.set(r.x, r.h / 2, r.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(r.w, r.h, r.d);
      dummy.updateMatrix();
      bodyMesh.setMatrixAt(i, dummy.matrix);
      this.collision.addBox(r.x, r.h / 2, r.z, r.w, r.h, r.d, 'rack');
    });
    bodyMesh.instanceMatrix.needsUpdate = true;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.frustumCulled = false;
    this.group.add(bodyMesh);

    const shelves = [];
    for (const r of racks) {
      for (let y = 0.8; y < r.h; y += 0.9) {
        shelves.push({ x: r.x, y, z: r.z, w: r.w + 0.06, d: r.d });
      }
    }
    const shelfMesh = new THREE.InstancedMesh(unit, this.matBeam, shelves.length);
    shelves.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(s.w, 0.08, s.d);
      dummy.updateMatrix();
      shelfMesh.setMatrixAt(i, dummy.matrix);
    });
    shelfMesh.instanceMatrix.needsUpdate = true;
    shelfMesh.castShadow = true;
    shelfMesh.frustumCulled = false;
    this.group.add(shelfMesh);
  }

  // ---------------- 集装箱 ----------------
  _buildContainers() {
    const containers = this.layout.containers || [];
    if (containers.length === 0) return;
    const matDark = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75, metalness: 0.3 });
    const containerNormal = normalTextureFromCanvas(containerBumpTexture().image, 1.1);
    const ribGeo = new THREE.BoxGeometry(0.08, 2.4, 2.42);
    const ribCount = containers.length * 11;
    const ribMesh = new THREE.InstancedMesh(ribGeo, matDark, ribCount);
    const dummy = new THREE.Object3D();
    let ri = 0;
    for (const c of containers) {
      const mat = new THREE.MeshStandardMaterial({
        color: c.color != null ? c.color : 0x7a4a2a,
        normalMap: containerNormal,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughness: 0.72, metalness: 0.35,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.4), mat);
      box.position.set(c.x, 1.3, c.z);
      box.rotation.y = c.rot || 0;
      box.castShadow = true;
      box.receiveShadow = true;
      this.group.add(box);
      // 加强筋：逐根计算世界坐标，最后合成一个 InstancedMesh
      const rot = c.rot || 0;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      for (let i = -2.5; i <= 2.5; i += 0.5) {
        dummy.position.set(c.x + i * cos, 1.3, c.z - i * sin);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        ribMesh.setMatrixAt(ri++, dummy.matrix);
      }
      const w = Math.abs(Math.cos(rot)) * 6 + Math.abs(Math.sin(rot)) * 2.4;
      const d = Math.abs(Math.sin(rot)) * 6 + Math.abs(Math.cos(rot)) * 2.4;
      this.collision.addBox(c.x, 1.3, c.z, w, 2.6, d, 'container');
    }
    ribMesh.instanceMatrix.needsUpdate = true;
    ribMesh.castShadow = true;
    ribMesh.frustumCulled = false;
    this.group.add(ribMesh);
  }

  // ---------------- 道具：油桶 / 沙袋 / 轮胎 / 标线 / 车头 ----------------
  _buildProps() {
    const L = this.layout;
    const dummy = new THREE.Object3D();

    // 油桶
    const barrels = L.barrels || [];
    if (barrels.length > 0) {
      const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.95, 12);
      const barrelMat = new THREE.MeshStandardMaterial({ color: 0x9a5a22, roughness: 0.5, metalness: 0.65 });
      const barrelMesh = new THREE.InstancedMesh(barrelGeo, barrelMat, barrels.length);
      barrels.forEach(([x, z], i) => {
        dummy.position.set(x, 0.475, z);
        dummy.rotation.set(0, Math.random() * Math.PI, 0);
        dummy.updateMatrix();
        barrelMesh.setMatrixAt(i, dummy.matrix);
        const box = this.collision.addBox(x, 0.475, z, 0.7, 0.95, 0.7, 'barrel');
        this.barrels.push({ position: new THREE.Vector3(x, 0.475, z), box });
      });
      barrelMesh.instanceMatrix.needsUpdate = true;
      barrelMesh.castShadow = true;
      barrelMesh.receiveShadow = true;
      this.group.add(barrelMesh);
    }

    // 沙袋堆
    const sandbagGroups = L.sandbags || [];
    const sandbagGeo = new THREE.BoxGeometry(1.0, 0.45, 0.55);
    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8a7a52, roughness: 0.95, metalness: 0.0 });
    for (const sg of sandbagGroups) {
      for (let i = 0; i < sg.count; i++) {
        const ox = (i - (sg.count - 1) / 2) * 1.05;
        const x = sg.x + ox * Math.cos(sg.ry);
        const z = sg.z + ox * Math.sin(sg.ry);
        const m = new THREE.Mesh(sandbagGeo, sandbagMat);
        m.position.set(x, 0.225, z);
        m.rotation.y = sg.ry;
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        this.collision.addBox(x, 0.225, z, 1.0, 0.45, 0.55, 'crate');
      }
    }

    // 轮胎堆
    const tireStacks = L.tires || [];
    if (tireStacks.length > 0) {
      const tireGeo = new THREE.TorusGeometry(0.42, 0.16, 8, 16);
      const tireMat = new THREE.MeshStandardMaterial({ color: 0x222426, roughness: 0.85, metalness: 0.1 });
      for (const ts of tireStacks) {
        for (let i = 0; i < ts.n; i++) {
          const t = new THREE.Mesh(tireGeo, tireMat);
          t.position.set(ts.x, 0.42 + i * 0.34, ts.z);
          t.rotation.x = Math.PI / 2 + (i % 2) * 0.15;
          t.rotation.z = i * 0.3;
          t.castShadow = true;
          t.receiveShadow = true;
          this.group.add(t);
        }
        this.collision.addBox(ts.x, ts.n * 0.17, ts.z, 0.8, ts.n * 0.34 + 0.2, 0.8, 'crate');
      }
    }

    // 地面安全标线
    const lines = L.lines || [];
    if (lines.length > 0) {
      const lineMat = new THREE.MeshBasicMaterial({ color: 0xd0a72c, transparent: true, opacity: 0.38 });
      const lineGeo = new THREE.PlaneGeometry(1, 1);
      for (const [x, z, w, d] of lines) {
        const m = new THREE.Mesh(lineGeo, lineMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0.008, z);
        m.scale.set(w, d, 1);
        this.group.add(m);
      }
    }

    // 堆叠货箱（集装箱顶）
    const stacks = [];
    for (const c of (L.stacks || [])) {
      for (let i = -1; i <= 1; i++) {
        for (let j = 0; j < 2; j++) {
          const ox = i * 1.7;
          const oz = (j - 0.5) * 1.1;
          stacks.push({
            x: c.x + ox * Math.cos(c.rot || 0) - oz * Math.sin(c.rot || 0),
            y: c.y != null ? c.y : 2.85,
            z: c.z + ox * Math.sin(c.rot || 0) + oz * Math.cos(c.rot || 0),
            ry: (Math.random() - 0.5) * 0.4,
          });
        }
      }
    }
    if (stacks.length > 0) {
      const stackGeo = new THREE.BoxGeometry(0.62, 0.5, 0.62);
      const stackMesh = new THREE.InstancedMesh(stackGeo, this.matCardboard, stacks.length);
      stacks.forEach((s, i) => {
        dummy.position.set(s.x, s.y, s.z);
        dummy.rotation.set(0, s.ry, 0);
        dummy.updateMatrix();
        stackMesh.setMatrixAt(i, dummy.matrix);
      });
      stackMesh.instanceMatrix.needsUpdate = true;
      stackMesh.castShadow = true;
      stackMesh.receiveShadow = true;
      this.group.add(stackMesh);
    }

    // 报废车头
    const cars = L.cars || [];
    if (cars.length > 0) {
      const carMat = new THREE.MeshStandardMaterial({ color: 0x6e3b2e, roughness: 0.72, metalness: 0.4 });
      const carGlass = new THREE.MeshStandardMaterial({ color: 0x223038, roughness: 0.3, metalness: 0.6 });
      for (const [cx, cz, ry] of cars) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.15, 2.0), carMat);
        body.position.y = 0.85;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.95, 1.85), carMat);
        cab.position.set(-0.4, 1.85, 0);
        const win = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.62, 1.9), carGlass);
        win.position.set(-0.4, 1.9, 0);
        const hood = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.9), carMat);
        hood.position.set(1.7, 1.25, 0);
        for (const part of [body, cab, win, hood]) {
          part.castShadow = true;
          part.receiveShadow = true;
          g.add(part);
        }
        g.position.set(cx, 0, cz);
        g.rotation.y = ry;
        this.group.add(g);
        const box = this.collision.addBox(cx, 1.2, cz, 4.6, 2.4, 2.2, 'car');
        this.cars.push({ position: new THREE.Vector3(cx, 0, cz), box });
      }
    }
  }

  // ---------------- 水泥柱阵（地下车库等室内图） ----------------
  _buildPillars() {
    const pillars = this.layout.pillars || [];
    if (pillars.length === 0) return;
    const mat = new THREE.MeshStandardMaterial({ color: 0x7d8288, roughness: 0.9, metalness: 0.05 });
    for (const p of pillars) {
      const r = p.r != null ? p.r : 0.55;
      const h = p.h != null ? p.h : 4.2;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 10), mat);
      m.position.set(p.x, h / 2, p.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.collision.addBox(p.x, h / 2, p.z, r * 2, h, r * 2, 'pillar');
    }
  }

  // ---------------- 远景剪影（地图外，只看不碰） ----------------
  _buildSilhouettes() {
    const blocks = this.layout.silhouettes || [];
    for (const [x, z, w, h, d] of blocks) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.matSilhouette);
      m.position.set(x, h / 2 - 2, z);
      this.group.add(m);
    }
  }

  // ---------------- 灯光 ----------------
  _buildLights() {
    const L = this.layout;
    const cfg = { ...DEFAULT_LIGHTS, ...(L.lights || {}) };

    const hemi = new THREE.HemisphereLight(cfg.hemiSky, cfg.hemiGround, cfg.hemiIntensity);
    this.scene.add(hemi);
    this.sceneObjects.push(hemi);

    const dir = new THREE.DirectionalLight(cfg.sunColor, cfg.sunIntensity);
    dir.position.set(cfg.sunPos[0], cfg.sunPos[1], cfg.sunPos[2]);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -36;
    dir.shadow.camera.right = 36;
    dir.shadow.camera.top = 32;
    dir.shadow.camera.bottom = -32;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 110;
    dir.shadow.bias = -0.0006;
    dir.shadow.normalBias = 0.025;
    this.scene.add(dir);
    this.sceneObjects.push(dir);

    const fill = new THREE.DirectionalLight(cfg.fillColor, cfg.fillIntensity);
    fill.position.set(cfg.fillPos[0], cfg.fillPos[1], cfg.fillPos[2]);
    this.scene.add(fill);
    this.sceneObjects.push(fill);

    const ambient = new THREE.AmbientLight(cfg.ambientColor, cfg.ambientIntensity);
    this.scene.add(ambient);
    this.sceneObjects.push(ambient);

    // 场地灯柱
    const lamps = L.lamps || [];
    if (lamps.length > 0) {
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.6, metalness: 0.5 });
      for (const [x, z] of lamps) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 6.4, 8), poleMat);
        pole.position.set(x, 3.2, z);
        pole.castShadow = true;
        this.group.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.4), poleMat);
        head.position.set(x, 6.35, z);
        this.group.add(head);
        const lamp = new THREE.PointLight(0xffe0a8, 2.2, 22, 1.8);
        lamp.position.set(x, 6.1, z);
        this.scene.add(lamp);
        this.sceneObjects.push(lamp);
      }
    }
  }

  /** 切换地图时移除本图所有对象（灯光 + 几何体），不做纹理释放以免误删共享资源 */
  dispose() {
    this.scene.remove(this.group);
    for (const obj of this.sceneObjects) this.scene.remove(obj);
    this.sceneObjects.length = 0;
  }

  // ---------------- 建筑 / 据点：带门洞的矩形建筑 + 屋顶 + 二层阳台 ----------------
  _buildBuildings() {
    const buildings = this.layout.buildings || [];
    if (buildings.length === 0) return;
    const matWall = this.matConcrete;
    const matRoof = new THREE.MeshStandardMaterial({ color: 0x4a4f54, roughness: 0.85, metalness: 0.1 });
    const matDoor = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.7, metalness: 0.1 });

    for (const b of buildings) {
      const { x, z, w, d, h, floors = 1, entry = true, balcony = false } = b;
      const yStep = h / floors;
      const doorW = 1.2, doorH = 2.0;

      // 每层墙（四面）+ 楼板
      for (let f = 0; f < floors; f++) {
        const fy = f * yStep;
        const fw = w - 0.04;
        const fh = yStep - 0.04;

        // 前/后墙
        const front = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.2), matWall);
        front.position.set(x, fy + fh / 2, z - d / 2);
        front.castShadow = true; front.receiveShadow = true;
        this.group.add(front);
        this.collision.addBox(x, fy + fh / 2, z - d / 2, fw, fh, 0.22, 'wall');

        const back = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.2), matWall);
        back.position.set(x, fy + fh / 2, z + d / 2);
        back.castShadow = true; back.receiveShadow = true;
        this.group.add(back);
        this.collision.addBox(x, fy + fh / 2, z + d / 2, fw, fh, 0.22, 'wall');

        // 左/右墙
        const left = new THREE.Mesh(new THREE.BoxGeometry(0.2, fh, d), matWall);
        left.position.set(x - w / 2, fy + fh / 2, z);
        left.castShadow = true; left.receiveShadow = true;
        this.group.add(left);
        this.collision.addBox(x - w / 2, fy + fh / 2, z, 0.22, fh, d, 'wall');

        const right = new THREE.Mesh(new THREE.BoxGeometry(0.2, fh, d), matWall);
        right.position.set(x + w / 2, fy + fh / 2, z);
        right.castShadow = true; right.receiveShadow = true;
        this.group.add(right);
        this.collision.addBox(x + w / 2, fy + fh / 2, z, 0.22, fh, d, 'wall');

        // 一层正面开门洞：门体本身可碰撞，玩家可开门通过（此处简化为无碰撞门洞位置）
        if (f === 0 && entry) {
          const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.22), matDoor);
          door.position.set(x, fy + 1.0, z - d / 2 - 0.12);
          door.castShadow = true; door.receiveShadow = true;
          this.group.add(door);
        }

        // 楼板（除顶层外）
        if (f < floors - 1) {
          const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.1, d - 0.1), matWall);
          floorMesh.rotation.x = -Math.PI / 2;
          floorMesh.position.set(x, fy + yStep, z);
          floorMesh.receiveShadow = true;
          this.group.add(floorMesh);
        }
      }

      // 屋顶
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.05, 0.5, d * 1.05), matRoof);
      roof.position.set(x, h + 0.25, z);
      roof.castShadow = true; roof.receiveShadow = true;
      this.group.add(roof);
      this.collision.addBox(x, h + 0.25, z, w * 1.05, 0.5, d * 1.05, 'wall');

      // 二层阳台（供攀爬/据点）
      if (balcony && floors >= 2) {
        const balW = w * 0.9;
        const balconyFloor = new THREE.Mesh(new THREE.PlaneGeometry(balW, 1.0), matWall);
        balconyFloor.rotation.x = -Math.PI / 2;
        balconyFloor.position.set(x, h - yStep * 0.5, z - d / 2 - 0.55);
        balconyFloor.receiveShadow = true;
        this.group.add(balconyFloor);
        const balconyWall = new THREE.Mesh(new THREE.BoxGeometry(balW, 1.1, 0.15), matWall);
        balconyWall.position.set(x, h - yStep * 0.5 + 0.55, z - d / 2 - 1.05);
        balconyWall.castShadow = true; balconyWall.receiveShadow = true;
        this.group.add(balconyWall);
        this.collision.addBox(x, h - yStep * 0.5 + 0.55, z - d / 2 - 1.05, balW, 1.1, 0.17, 'wall');
      }
    }
  }

  // ---------------- 出生点 / 巡逻点合法性修正 ----------------
  /**
   * 建筑的四周墙是完整碰撞盒（门只是装饰，不能穿过），
   * 出生点/巡逻点若落在建筑或集装箱等碰撞体内部，丧尸会刷进无法进入的房子里并卡死。
   * 这里在建图完成后用碰撞检测校验，非法点外扩到最近的可站立空地。
   */
  _resolveNavigationPoints() {
    this.spawnPoints = this._relocatePoints(this.spawnPoints);
    this.waypoints = this._relocatePoints(this.waypoints);
  }

  _relocatePoints(points) {
    const out = [];
    for (const p of points) {
      const spot = this._findFreeSpot(p);
      if (spot) out.push(spot);
    }
    return out;
  }

  /** 点本身可用则原地返回，否则螺旋外扩找最近的可站立点；找不到返回 null */
  _findFreeSpot(p) {
    const R = ENEMY.radius + 0.05;
    const H = ENEMY.height;
    const halfX = this.layout.halfX;
    const halfZ = this.layout.halfZ;
    const free = (x, z) => {
      if (Math.abs(x) > halfX - R || Math.abs(z) > halfZ - R) return false;
      return this.collision.canFit(new THREE.Vector3(x, 0, z), R, H);
    };
    if (free(p.x, p.z)) return new THREE.Vector3(p.x, 0, p.z);

    for (let r = 0.6; r <= 9; r += 0.4) {
      const steps = Math.max(8, Math.round(r * 8));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = p.x + Math.cos(a) * r;
        const z = p.z + Math.sin(a) * r;
        if (free(x, z)) return new THREE.Vector3(x, 0, z);
      }
    }
    return null;
  }
}
