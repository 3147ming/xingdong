/**
 * 第一人称武器视图（挂在相机下）
 * - 复用仓库 arms@ak.fbx（带手臂的 AK 模型，作为 M4 类步枪外观）
 * - 独立处理：待机呼吸、移动摆动、开火后坐、换弹动画、枪口闪光
 */
import * as THREE from 'three';
import { clone as cloneSkeleton } from '../../vendor/three/utils/SkeletonUtils.js';
import { WEAPON, WEAPONS } from '../config/weapon.js';

/**
 * 各 GLB 武器的真实朝向（烘焙节点变换后的模型坐标系）
 * 已通过多视角渲染逐把确认：forward = 枪口方向，up = 枪身上方。
 * 手调 view.rotation 会再次把枪扭歪，除非重新渲染确认，不要改这里。
 */
const GLB_ORIENT = {
  pistol:  { forward: [ 1, 0, 0], up: [0, 1, 0] },  // 枪口 +X，套筒在上
  shotgun: { forward: [ 1, 0, 0], up: [0, 1, 0] },  // 枪口 +X，枪托在 -X
  sniper:  { forward: [-1, 0, 0], up: [0, 1, 0] },  // 枪口 -X，瞄准镜在上
  smg:     { forward: [ 0, 0,-1], up: [-1, 0, 0] },  // 枪口 -Z，且原模型侧躺（上方 = -X）
  default: { forward: [ 1, 0, 0], up: [0, 1, 0] },
};

/** 生成枪口闪光贴图 */
function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,230,1)');
  g.addColorStop(0.25, 'rgba(255,220,120,0.95)');
  g.addColorStop(0.55, 'rgba(255,140,30,0.45)');
  g.addColorStop(1, 'rgba(255,90,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(64, 64, 62, 0, Math.PI * 2);
  ctx.fill();

  // 四角星芒
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,240,190,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(4, 64); ctx.lineTo(124, 64); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(64, 8); ctx.lineTo(64, 120); ctx.stroke();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class WeaponView {
  /**
   * @param {THREE.Camera} camera 主相机
   * @param {object} assets 资源
   * @param {THREE.PerspectiveCamera} [viewCamera] 武器独立视图相机（可选）
   *   传入后武器不再属于主场景，渲染时清深度单独绘制 —— 枪身永远不会穿墙。
   */
  constructor(camera, assets, viewCamera = null) {
    this.camera = camera;
    this.assets = assets;
    this.viewCamera = viewCamera;
    this.pivot = new THREE.Group();
    this.basePos = new THREE.Vector3();
    this.baseRot = new THREE.Euler();

    this.kick = 0;            // 后坐动画进度
    this.swayX = 0;
    this.swayY = 0;
    this.idleTime = 0;
    this.flashTime = 0;
    this.magazine = null;
    this.magBaseY = 0;

    // 模型注册表：每把枪独立的 THREE.Group（含模型 + 自算包围盒）
    this._models = {};   // art -> { group, size, center, visible }

    // muzzleLocal 必须在 _buildFlash 前存在（flash + flashLight 的 position.copy 要用）
    this.muzzleLocal = new THREE.Vector3(0, 0.01, 0.35);

    if (this.viewCamera) this._buildViewScene();
    else camera.add(this.pivot);

    this._buildAllModels();
    this._buildArms();
    this._buildFlash();
    this.switchAnim = 1;      // 切枪滑入动画进度（1 = 已完成）
    this.sprintK = 0;         // 疾跑端枪姿态 0~1
    this.vaultK = 0;          // 翻越支撑姿态 0~1
    this.landK = 0;           // 落地缓冲 0~1
  }

  /**
   * 武器独立视图场景：只装武器 + 一套固定打光，和主场景的雾 / 阴影完全隔离。
   * 这样武器既不会穿墙，也不会被世界里的爆炸闪白、昼夜光照变化影响。
   */
  _buildViewScene() {
    this.viewScene = new THREE.Scene();
    this.viewCamera.add(this.pivot);
    this.viewScene.add(this.viewCamera);
    this._tmpPos = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();

    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    this.viewScene.add(amb);
    // 主光：来自右上前方，给枪身拉出长条高光
    const key = new THREE.DirectionalLight(0xffeee0, 1.5);
    key.position.set(0.6, 1.0, 0.45);
    this.viewScene.add(key);
    // 补光：偏冷的左后方，避免暗部死黑
    const fill = new THREE.DirectionalLight(0x8fb6dd, 0.55);
    fill.position.set(-0.7, 0.15, -0.6);
    this.viewScene.add(fill);
  }

  /** 主场景 PMREM 环境贴图共享给武器场景（金属反射必须） */
  setEnvironment(env) {
    if (this.viewScene) this.viewScene.environment = env || null;
  }

  /** 武器独立相机的世界变换同步到主相机（开火取枪口坐标前必须先做一次） */
  _syncViewCamera() {
    if (!this.viewCamera) return;
    this.camera.getWorldPosition(this._tmpPos);
    this.camera.getWorldQuaternion(this._tmpQuat);
    this.viewCamera.position.copy(this._tmpPos);
    this.viewCamera.quaternion.copy(this._tmpQuat);
    this.viewCamera.updateMatrixWorld(true);
  }

  /**
   * 单独绘制武器：主场景后期处理完成后、在画布上清深度再画一遍。
   * 与主相机共用 fov / 宽高比（开镜变焦时武器同步放大）。
   */
  renderOverlay(renderer) {
    if (!this.viewScene || !this.viewCamera || !this.pivot.visible) return;
    const cam = this.viewCamera;
    const fov = this.camera.fov;
    const aspect = this.camera.aspect;
    if (cam.fov !== fov || cam.aspect !== aspect) {
      cam.fov = fov;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    // 独立相机不挂在主相机下（一个节点只能有一个父级），每帧同步世界变换
    this._syncViewCamera();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.viewScene, cam);
    renderer.autoClear = prevAutoClear;
  }

  /**
   * 第一人称手臂：战术袖 + 小臂 + 腕口 + 带四指与拇指的战术手套。
   * 手部与枪身同轴（指尖朝枪口），手指向枪身上方收拢，形成"握住"的姿态。
   */
  _buildArms() {
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x39413c, roughness: 0.95, metalness: 0.02 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0x9b755b, roughness: 0.82, metalness: 0.0 });
    const cuffMat = new THREE.MeshStandardMaterial({ color: 0x2a2f31, roughness: 0.88, metalness: 0.06 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.78, metalness: 0.12 });
    const knuckleMat = new THREE.MeshStandardMaterial({ color: 0x171a1d, roughness: 0.6, metalness: 0.2 });

    const sleeveGeo = new THREE.CylinderGeometry(0.054, 0.043, 1, 10, 1);
    sleeveGeo.translate(0, 0.5, 0);   // 以底端为原点，向 +Y 延伸，用 scale.y 控制长度
    const foreGeo = new THREE.CylinderGeometry(0.041, 0.031, 1, 10, 1);
    foreGeo.translate(0, 0.5, 0);
    const cuffGeo = new THREE.CylinderGeometry(0.045, 0.041, 0.038, 10, 1);
    cuffGeo.translate(0, 0.019, 0);

    const mk = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.visible = false;
      this.pivot.add(m);
      return m;
    };

    // 单只手：手掌 + 手背护垫 + 四指 + 拇指
    const makeHand = () => {
      const g = new THREE.Group();
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.074, 0.05, 0.098), gloveMat);
      g.add(palm);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.016, 0.07), knuckleMat);
      pad.position.set(0, 0.033, 0.002);
      g.add(pad);
      // 四指：位于掌前端，向枪身上方弯折包住护木 / 握把
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.0145, 0.03, 0.05), gloveMat);
        f.position.set(-0.026 + i * 0.0175, 0.014, 0.062);
        f.rotation.x = -0.95;
        g.add(f);
      }
      // 拇指：从掌侧斜向扣住
      const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.026, 0.052), gloveMat);
      thumb.position.set(0.042, 0.010, 0.018);
      thumb.rotation.set(-0.3, 0.55, 0.4);
      g.add(thumb);
      g.traverse((o) => { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; });
      g.visible = false;
      this.pivot.add(g);
      return g;
    };

    this._arms = {
      R: { sleeve: mk(sleeveGeo, sleeveMat), fore: mk(foreGeo, skinMat), cuff: mk(cuffGeo, cuffMat), hand: makeHand() },
      L: { sleeve: mk(sleeveGeo, sleeveMat), fore: mk(foreGeo, skinMat), cuff: mk(cuffGeo, cuffMat), hand: makeHand() },
    };
  }

  /** 按当前武器尺寸摆放两只手臂：右手在握把（枪身后段下方），左手在前护木 */
  _placeArms(size, off, modelScale, anim = {}) {
    if (!this._arms || !size) return;
    this._armArgs = { size, off, modelScale };
    const d2 = size.z * modelScale;
    const h2 = size.y * modelScale;
    const gripZ = (off.z || 0) + d2 * 0.30;      // 枪身 +Z 一侧 = 枪托/握把
    const foreZ = (off.z || 0) - d2 * 0.26;      // -Z 一侧 = 前护木
    const handY = (off.y || 0) - h2 * 0.42;

    const sprint = anim.sprint || 0;
    const vault = anim.vault || 0;

    const rightShoulder = new THREE.Vector3(0.11, -0.50, 0.30);
    const leftShoulder = new THREE.Vector3(-0.06, -0.50, 0.22);
    const rightHand = new THREE.Vector3(0.005, handY - sprint * 0.02, gripZ);
    // 翻越时左手前伸撑住箱沿
    const leftHand = new THREE.Vector3(-0.02, handY + vault * 0.10, foreZ - vault * 0.12);

    this._placeArmChain(this._arms.R, rightShoulder, rightHand, 1);
    this._placeArmChain(this._arms.L, leftShoulder, leftHand, -1);
  }

  /** 袖子（肩→肘）+ 小臂（肘→腕口）+ 手套（手掌处） */
  _placeArmChain(arm, shoulder, hand, side) {
    const elbow = new THREE.Vector3()
      .addVectors(shoulder, hand).multiplyScalar(0.5)
      .add(new THREE.Vector3(0.03 * side, -0.03, 0.015));
    this._placeSegment(arm.sleeve, shoulder, elbow);

    const dir = new THREE.Vector3().subVectors(hand, elbow).normalize();
    const wrist = hand.clone().addScaledVector(dir, -0.055);
    this._placeSegment(arm.fore, elbow, wrist);

    arm.cuff.position.copy(wrist);
    arm.cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    // 手掌与枪身同轴，指尖朝枪口，略微内收
    arm.hand.position.copy(hand);
    arm.hand.rotation.set(0, side * 0.10, side * -0.05);
  }

  _placeSegment(mesh, a, b) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = Math.max(0.05, dir.length());
    mesh.position.copy(a);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }

  _setArmsVisible(on) {
    if (!this._arms) return;
    for (const arm of Object.values(this._arms)) {
      arm.sleeve.visible = on;
      arm.fore.visible = on;
      arm.cuff.visible = on;
      arm.hand.visible = on;
    }
  }

  /** 构建所有可用武器模型（5 种），都挂在 pivot 下但初始隐藏 */
  _buildAllModels() {
    // 1. Rifle（AK74 FBX）
    this._buildRifleModel();
    // 2. Pistol / Shotgun / Sniper / SMG（GLB）
    //  枪管方向由模型真实 bbox 最长边自动判断，统一旋转到 +Z，再经 pivot y=PI 翻到 -Z
    this._buildGlbModel('pistol', this.assets?.weapons?.pistol);
    this._buildGlbModel('shotgun', this.assets?.weapons?.shotgun);
    this._buildGlbModel('sniper', this.assets?.weapons?.sniper);
    this._buildGlbModel('smg', this.assets?.weapons?.smg);
    // 3. RPG-7（几何体）
    this._buildRpgModel();
  }

  /** 构建 AK74 步枪模型（从带手臂的 FBX 克隆，隐藏手臂） */
  _buildRifleModel() {
    const src = this.assets && this.assets.weaponModel;
    let group, size, center;

    if (!src) {
      // 兜底：简单几何体
      group = new THREE.Group();
      const gun = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.1, 0.7),
        new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.6 })
      );
      group.add(gun);
      size = new THREE.Vector3(0.06, 0.1, 0.7);
      center = new THREE.Vector3(0, 0, 0);
    } else {
      group = cloneSkeleton(src);
      group.rotation.set(0, 0, 0);
      // 材质 + 可见性
      group.traverse((o) => {
        if (!o.isMesh) return;
        const n = o.name.toLowerCase();
        if (n.includes('arm') || o.isSkinnedMesh) { o.visible = false; return; }
        const m = o.material;
        if (m && !Array.isArray(m)) {
          if (m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping; }
          // FBX 默认给 MeshPhongMaterial，不吃环境反射会显得发黑；统一转成 PBR 才有金属质感
          if (m.isMeshPhongMaterial || m.isMeshLambertMaterial) {
            const std = new THREE.MeshStandardMaterial({
              map: m.map || null,
              color: m.color ? m.color.clone() : 0xffffff,
              transparent: m.transparent,
              opacity: m.opacity,
              alphaTest: m.alphaTest,
              side: m.side,
              roughness: 0.48,
              metalness: 0.3,
              envMapIntensity: 1.3,
            });
            o.material = std;
          } else {
            if ('envMapIntensity' in m) m.envMapIntensity = 1.35;
            if ('metalness' in m) m.metalness = Math.min(m.metalness, 0.85);
            if ('roughness' in m) m.roughness = Math.max(0.3, Math.min(m.roughness, 0.85));
          }
          o.material.needsUpdate = true;
        }
        o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
        if (n.includes('mag')) { this.magazine = o; this.rifleMagazine = o; this.magBaseY = o.position.y; }
      });
      // 包围盒（仅枪身 mesh，跳过手臂）
      group.updateMatrixWorld(true);
      const box = new THREE.Box3();
      group.traverse((o) => {
        if (!o.isMesh || o.visible === false) return;
        const n = o.name.toLowerCase();
        if (n.includes('arm') || o.isSkinnedMesh) return;
        o.geometry.computeBoundingBox();
        if (!o.geometry.boundingBox) return;
        const mb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        box.union(mb);
      });
      if (box.isEmpty()) box.set(new THREE.Vector3(-0.05, -0.05, -0.5), new THREE.Vector3(0.05, 0.05, 0.5));
      size = box.getSize(new THREE.Vector3());
      center = box.getCenter(new THREE.Vector3());
    }

    group.visible = false;
    this.pivot.add(group);
    this._models.rifle = { group, size, center, barrelAxis: 'Z' };
  }

  /** 从 GLB 克隆构建一把武器：烘焙节点变换后，按模型真实朝向对齐到「枪口 +Z、枪身竖直」 */
  _buildGlbModel(artKey, srcScene) {
    let group;
    if (srcScene) {
      group = srcScene.clone(true);
    } else {
      group = new THREE.Group();
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.1, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x555555 })
      );
      group.add(box);
    }

    // 烘焙所有节点变换到 geometry，重置节点变换，消除 GLB 节点自带 rotation/scale 的干扰
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.applyMatrix4(o.matrixWorld);
      o.position.set(0, 0, 0);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrixWorld();
    });
    group.rotation.set(0, 0, 0);

    // 材质处理 + 可见性
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
      const m = o.material;
      if (m) {
        if (m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping; }
        if ('envMapIntensity' in m) m.envMapIntensity = 1.35;   // 金属反射更明显，避免渲染成黑影
        if ('metalness' in m) m.metalness = Math.min(m.metalness, 0.85);
        if ('roughness' in m) m.roughness = Math.max(0.3, Math.min(m.roughness, 0.85));
        m.needsUpdate = true;
      }
    });

    // 按每把枪的真实朝向做正交对齐（已用多视角渲染逐把确认真实朝向，勿随意改动）：
    //   forward = 枪口方向，up = 枪身上方
    //   目标：枪口 +Z（再由 pivot.rotation.y = PI 翻到相机前方 -Z），枪身上方 +Y
    const orient = GLB_ORIENT[artKey] || GLB_ORIENT.default;
    const f = new THREE.Vector3(...orient.forward).normalize();
    const u = new THREE.Vector3(...orient.up).normalize();
    const r = new THREE.Vector3().crossVectors(f, u).normalize();
    const tf = new THREE.Vector3(0, 0, 1);
    const tu = new THREE.Vector3(0, 1, 0);
    const tr = new THREE.Vector3(-1, 0, 0);  // right = forward × up = +Z × +Y = -X
    const A = new THREE.Matrix4().makeBasis(f, u, r);
    const B = new THREE.Matrix4().makeBasis(tf, tu, tr);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(B, A.transpose()));

    // 对齐后的包围盒（枪管沿 Z，枪口在 +Z 端）
    group.updateMatrixWorld(true);
    const bakedBox = new THREE.Box3().setFromObject(group);
    const bakedSize = bakedBox.getSize(new THREE.Vector3());
    const bakedCenter = bakedBox.getCenter(new THREE.Vector3());

    group.visible = false;
    this.pivot.add(group);
    this._models[artKey] = { group, size: bakedSize, center: bakedCenter };
  }

  /**
   * RPG-7 几何体模型：发射筒 + 喷管 + 战斗部 + 握把 + 机械瞄具。
   * 单独一套模型，切到 rpg 时显示、切换到其他武器时隐藏。
   */
  _buildRpgModel() {
    const g = new THREE.Group();
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0x4a5340, roughness: 0.62, metalness: 0.35, envMapIntensity: 1.2 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x2e3236, roughness: 0.42, metalness: 0.65, envMapIntensity: 1.5 });
    const warheadMat = new THREE.MeshStandardMaterial({ color: 0x8a2b1c, roughness: 0.55, metalness: 0.2, envMapIntensity: 1.1 });

    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.3, 12), tubeMat);
    tube.rotation.x = Math.PI / 2;
    g.add(tube);

    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.075, 0.24, 12), metalMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.z = -0.72;   // 喷嘴在后端（向玩家，+Z 端经 pivot y=PI 翻到 +Z 朝玩家）
    g.add(nozzle);

    const warhead = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.3, 12), warheadMat);
    warhead.rotation.x = -Math.PI / 2;
    warhead.position.z = 0.78;   // 战斗部在前端（远离玩家，+Z 端经 pivot y=PI 翻到 -Z 朝前）
    g.add(warhead);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.24, 0.11), metalMat);
    grip.position.set(0, -0.15, 0.12);
    grip.rotation.x = -0.25;
    g.add(grip);

    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.16), metalMat);
    sight.position.set(0, 0.13, -0.1);
    g.add(sight);

    g.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    });

    // 自然包围盒：必须在挂到 pivot 之前算，否则会带上相机的世界变换
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    g.visible = false;
    this.pivot.add(g);
    this._models.rpg = { group: g, size, center, barrelAxis: 'Z' };
  }

  /**
   * 按 viewConfig 重算模型缩放与偏移
   * - 最长边归一到 view.scale
   * - 模型中心对齐到 pivot 原点，再叠加 offset（让握把落在 pivot 附近）
   */
  _applyViewTransform() {
    if (!this.model) return;
    this._applyModelTransform(this.model, this._naturalSize, this._naturalCenter);
  }

  /** 通用模型变换：最长边归一到 view.scale，中心对齐 pivot 原点，再叠加 offset */
  _applyModelTransform(model, size, center) {
    if (!model || !size || !center) return;
    const v = this.viewConfig;
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const scale = (v.scale || 0.66) / maxDim;
    const off = v.offset || { x: 0, y: 0, z: 0 };

    model.scale.setScalar(scale);
    model.position.set(
      -center.x * scale + (off.x || 0),
      -center.y * scale + (off.y || 0),
      -center.z * scale + (off.z || 0)
    );
    this._modelScale = scale;
    this._placeArms(size, off, scale);
    this._refreshMuzzleFor(size, scale, off);
  }

  /**
   * 枪口锚点：所有武器模型都已对齐为「枪口 +Z、上 +Y」，pivot.rotation.y = PI 再把 +Z 翻到相机前方。
   * 因此在 pivot 本地坐标里，枪口位于包围盒 +Z 端（off.z + d/2），枪托在 -Z 端。
   * ⚠ 不能用 Box3.setFromObject 取——那是**世界坐标**，相机在场景里一移动就全错。
   *   这里按「原始包围盒 × 缩放 + 偏移」解析计算，结果始终在 pivot 本地坐标系。
   */
  _refreshMuzzle() {
    if (!this.model) return;
    this._refreshMuzzleFor(this._naturalSize, this.model.scale.x, this.viewConfig.offset || {});
  }

  /** 按给定自然尺寸 / 缩放 / 偏移计算枪口锚点（与具体模型无关） */
  _refreshMuzzleFor(n, s, off = {}) {
    if (!n) return;
    const w = n.x * s;
    const h = n.y * s;
    const d = n.z * s;
    this.modelSize = new THREE.Vector3(w, h, d);
    this.gunLength = d;
    this.muzzleLocal = new THREE.Vector3(
      off.x || 0,
      (off.y || 0) + h * 0.10,
      (off.z || 0) + d / 2 - 0.01
    );
    if (this.flash) {
      this.flash.position.copy(this.muzzleLocal);
      this.flashLight.position.copy(this.muzzleLocal);
    }
  }

  /** 运行时调整取景（供调试探针 / 设置项使用） */
  setViewConfig(partial) {
    this.viewConfig = { ...this.viewConfig, ...partial };
    if (partial.position) this.basePos.set(partial.position.x, partial.position.y, partial.position.z);
    if (partial.rotation) this.baseRot.set(partial.rotation.x, partial.rotation.y, partial.rotation.z);
    if (this.model) this._applyViewTransform();
  }

  /** 枪口闪光 + 点光源 */
  _buildFlash() {
    const tex = flashTexture();
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffe0a0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.flash = new THREE.Sprite(mat);
    this.flash.scale.setScalar(0.22);
    this.flash.visible = false;
    this.flash.position.copy(this.muzzleLocal);
    this.pivot.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffc070, 0, 9, 2);
    this.flashLight.position.copy(this.muzzleLocal);
    this.pivot.add(this.flashLight);
  }

  /** 开火表现 */
  triggerFire() {
    this.kick = Math.min(1.6, this.kick + 1);
    this.flashTime = 0.045;
    this.flash.visible = true;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.18 + Math.random() * 0.1);
    this.flashLight.intensity = 2.2;
  }

  /** 切换武器：按 art 选显示对应模型，其他全隐藏 */
  setWeapon(weaponConfig) {
    const v = weaponConfig.view;
    this.viewConfig = { ...v };
    const art = weaponConfig.art || 'rifle';

    // 先把所有模型隐藏
    for (const key of Object.keys(this._models)) {
      const m = this._models[key];
      if (m && m.group) m.group.visible = false;
    }

    // 取当前 art 的模型条目
    let entry = this._models[art];
    // 兜底：art 未知时回退到 rifle
    if (!entry) entry = this._models.rifle;
    if (!entry) return;

    const { group, size, center } = entry;
    group.visible = true;
    this._activeModel = entry;
    this.model = group;
    this._naturalSize = size;
    this._naturalCenter = center;
    this._setArmsVisible(true);
    this.switchAnim = 0;    // 新枪从下方滑入

    // 更新当前弹匣引用（仅 rifle 有）
    this.magazine = art === 'rifle' ? this.rifleMagazine : null;

    // 套 viewConfig 的 position / rotation / scale 到 pivot
    this.basePos.set(v.position.x, v.position.y, v.position.z);
    this.baseRot.set(v.rotation.x, v.rotation.y, v.rotation.z);
    this.pivot.position.copy(this.basePos);
    this.pivot.rotation.copy(this.baseRot);

    // 对激活模型应用缩放 + 中心对齐 + 偏移
    this._applyModelTransform(group, size, center);
  }

  /**
   * 每帧更新
   * @param {number} dt
   * @param {object} state { speed, moving, reloading, reloadProgress }
   * @param {{x:number,y:number}} mouseDelta
   */
  update(dt, state, mouseDelta) {
    this.idleTime += dt;

    // 后坐力衰减
    this.kick += (0 - this.kick) * Math.min(1, dt * 12);

    // 鼠标摆动（反向跟随；开镜时收敛）
    const aimK = Math.max(0, Math.min(1, state.aiming || 0));
    const swayTargetX = -mouseDelta.x * 0.0018 * (1 - aimK * 0.8);
    const swayTargetY = mouseDelta.y * 0.0016 * (1 - aimK * 0.7);
    this.swayX += (swayTargetX - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (swayTargetY - this.swayY) * Math.min(1, dt * 9);

    // 移动/呼吸摆动
    const bob = state.moving ? Math.sin(this.idleTime * 9) * 0.012 * (1 - aimK * 0.85) : 0;
    const breathe = Math.sin(this.idleTime * 1.7) * 0.004 * (1 - aimK * 0.9);
    // 空中：枪身微微下沉并左右轻摆
    const airDrop = state.airborne ? 0.03 : 0;
    const airSway = state.airborne ? Math.sin(this.idleTime * 3.2) * 0.008 : 0;

    const p = this.pivot.position;
    const restX = this.basePos.x + this.swayX + airSway;
    const restY = this.basePos.y + this.swayY + bob + breathe - airDrop - this.kick * 0.008;
    const restZ = this.basePos.z + this.kick * 0.055;
    // 开镜：枪身移到画面中线并下移到准星之下（三点一线：眼睛-准星-枪管）
    const adsX = 0;
    const adsY = this.basePos.y - 0.10;   // 下移，让枪位于准星下方，不遮挡准星
    const adsZ = this.basePos.z + 0.02;
    p.x = restX + (adsX - restX) * aimK;
    p.y = restY + (adsY - restY) * aimK;
    p.z = restZ + (adsZ - restZ) * aimK;

    const r = this.pivot.rotation;
    r.x = this.baseRot.x + this.kick * 0.05 * (1 - aimK * 0.4);
    r.y = this.baseRot.y + this.swayX * 1.4 * (1 - aimK * 0.75);
    r.z = this.baseRot.z + this.swayX * 0.6 * (1 - aimK * 0.75);

    // 疾跑端枪：枪身下压右倾；翻越：枪身侧倾；落地：短暂下沉回弹
    const sprintTarget = (state.sprinting && !state.reloading ? 1 : 0) * (1 - aimK);
    this.sprintK += (sprintTarget - this.sprintK) * Math.min(1, dt * 7);
    this.vaultK += ((state.vaulting ? 1 : 0) - this.vaultK) * Math.min(1, dt * 10);
    this.landK += (Math.min(1, (state.landShake || 0) * 22) - this.landK) * Math.min(1, dt * 14);
    const sp = this.sprintK;
    const vt = this.vaultK;
    p.y -= sp * 0.055 + vt * 0.02 + this.landK * 0.028;
    p.x += sp * 0.045;
    p.z += sp * 0.02;
    r.x += sp * 0.28 + vt * 0.22;
    r.z -= sp * 0.42 - vt * 0.12;
    r.y += vt * 0.10;

    // 手臂随姿态重摆：疾跑收枪、翻越时左手前撑
    if (this._armArgs) {
      this._placeArms(this._armArgs.size, this._armArgs.off, this._armArgs.modelScale, { sprint: sp, vault: vt });
    }

    // 切枪过渡：新枪从屏幕下方滑入（约 0.22 秒）
    if (this.switchAnim < 1) {
      this.switchAnim = Math.min(1, this.switchAnim + dt / 0.22);
      const k = 1 - Math.pow(1 - this.switchAnim, 3);   // easeOutCubic
      p.y -= (1 - k) * 0.30;
      p.z += (1 - k) * 0.12;
      r.x += (1 - k) * 0.35;
    }

    // 换弹动画（第三轮：拆成两段节奏 —— 0~55% 掏弹匣下压，55%~100% 插入弹匣回位）
    if (state.reloading) {
      const rp = Math.min(1, state.reloadProgress);
      let t;      // 枪身位移强度 0~1
      let drop;   // 弹匣下坠量
      if (rp < 0.55) {
        // 第一段：缓缓下压、弹匣抽出
        const k = rp / 0.55;
        t = Math.sin(k * Math.PI * 0.5);
        drop = Math.min(1, k * 1.6) * 0.06;
      } else {
        // 第二段：快速插入弹匣，枪身回位并保留短暂顿挫
        const k = (rp - 0.55) / 0.45;
        t = Math.pow(1 - Math.min(1, k / 0.7), 2);
        drop = 0.06 * (1 - Math.min(1, k * 1.6));
      }
      p.y -= t * 0.16;
      p.z += t * 0.06;
      r.x += t * 0.75;
      r.z -= t * 0.35;
      if (this.magazine) {
        this.magazine.position.y = this.magBaseY - drop;
      }
    } else if (this.magazine) {
      this.magazine.position.y += (this.magBaseY - this.magazine.position.y) * Math.min(1, dt * 12);
    }

    // 枪口闪光计时
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      this.flash.scale.setScalar(0.16 + Math.random() * 0.12);
      this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 45);
      if (this.flashTime <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }
  }

  /** 获取枪口世界坐标（用于弹道起点） */
  getMuzzleWorldPosition() {
    this._syncViewCamera();
    return this.flash.getWorldPosition(new THREE.Vector3());
  }
}
