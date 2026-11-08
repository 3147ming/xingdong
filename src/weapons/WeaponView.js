/**
 * 第一人称武器视图（挂在相机下）
 * - 复用仓库 arms@ak.fbx（带手臂的 AK 模型，作为 M4 类步枪外观）
 * - 独立处理：待机呼吸、移动摆动、开火后坐、换弹动画、枪口闪光
 */
import * as THREE from 'three';
import { clone as cloneSkeleton } from '../../vendor/three/utils/SkeletonUtils.js';
import { WEAPON, WEAPONS } from '../config/weapon.js';

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
  constructor(camera, assets) {
    this.camera = camera;
    this.assets = assets;
    this.pivot = new THREE.Group();
    camera.add(this.pivot);
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
    this.muzzleLocal = new THREE.Vector3(0, 0.01, -0.35);

    this._buildAllModels();
    this._buildFlash();
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
        if (m) {
          if (m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping; }
          m.needsUpdate = true;
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

  /** 从 GLB 克隆构建一把武器。烘焙所有节点变换到 geometry，再基于真实 bbox 方向把枪管对齐到 +Z */
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
    // 这样模型处于原始几何方向，bbox 反映真实枪管朝向
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
        m.needsUpdate = true;
      }
    });

    // 计算原始包围盒，根据最长边确定枪管所在轴，旋转到 +Z
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    if (maxDim === size.x) {
      // 枪管沿 X：绕 Y 轴 -PI/2 把 +X 转到 +Z
      group.rotation.y = -Math.PI / 2;
    } else if (maxDim === size.y) {
      // 枪管沿 Y：绕 X 轴 PI/2 把 +Y 转到 +Z（再经 pivot y=PI 翻到 -Z）
      group.rotation.x = Math.PI / 2;
    }
    // maxDim === size.z：枪管已沿 +Z，无需额外旋转

    // 再算一次烘焙 + 旋转后的包围盒（用于中心对齐）
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
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0x4a5340, roughness: 0.62, metalness: 0.35 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x2e3236, roughness: 0.5, metalness: 0.6 });
    const warheadMat = new THREE.MeshStandardMaterial({ color: 0x8a2b1c, roughness: 0.55, metalness: 0.2 });

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
    this._refreshMuzzleFor(size, scale, off);
  }

  /**
   * 枪口锚点：模型朝向 -Z，枪口在变换后包围盒的最前端（min.z）。
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
      (off.z || 0) - d / 2 + 0.01
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
    return this.flash.getWorldPosition(new THREE.Vector3());
  }
}
