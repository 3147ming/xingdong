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
    this.basePos = new THREE.Vector3(
      WEAPON.view.position.x,
      WEAPON.view.position.y,
      WEAPON.view.position.z
    );
    this.baseRot = new THREE.Euler(
      WEAPON.view.rotation.x,
      WEAPON.view.rotation.y,
      WEAPON.view.rotation.z
    );

    this.kick = 0;            // 后坐动画进度
    this.swayX = 0;
    this.swayY = 0;
    this.idleTime = 0;
    this.flashTime = 0;
    this.magazine = null;
    this.magBaseY = 0;

    this._buildModel();
    this._buildFlash();
  }

  /** 构建武器模型 */
  _buildModel() {
    const src = this.assets && this.assets.weaponModel;
    if (!src) {
      // 兜底：用简单几何体表示步枪
      const gun = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.1, 0.7),
        new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.6 })
      );
      this.gunLength = 0.7;
      this.model = gun;
      this._naturalSize = new THREE.Vector3(0.06, 0.1, 0.7);
      this._naturalCenter = new THREE.Vector3(0, 0, 0);
      this.pivot.add(gun);
      this.muzzleLocal = new THREE.Vector3(0, 0.01, -0.35);
      this.pivot.position.copy(this.basePos);
      this.pivot.rotation.copy(this.baseRot);
      return;
    }

    const model = cloneSkeleton(src);
    this.model = model;
    this.viewConfig = { ...WEAPON.view };

    // 材质处理：手臂用 armColor，枪身用 ak74Color
    const gunTex = this.assets.textures.ak74;
    if (gunTex) gunTex.wrapS = gunTex.wrapT = THREE.ClampToEdgeWrapping;
    const armTex = this.assets.textures.arm;

    model.traverse((o) => {
      if (!o.isMesh) return;
      const name = (o.name + ' ' + (o.material && o.material.name) || '').toLowerCase();
      const isArm = name.includes('arm');
      const map = isArm ? armTex : gunTex;
      const mat = new THREE.MeshStandardMaterial({
        map: map || null,
        color: map ? 0xffffff : 0x4a4f55,
        roughness: 0.55,
        metalness: 0.18,
      });
      o.material = mat;
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;

      // 记录弹匣节点，换弹时做位移动画
      if (o.name.toLowerCase().includes('mag')) {
        this.magazine = o;
        this.magBaseY = o.position.y;
      }
    });

    model.rotation.set(0, 0, 0);

    // ⚠ 包围盒只能按「可见的枪身网格」算。
    //   手臂网格（armmesh）比枪大几十倍，一旦算进去，缩放基准会被它带偏，
    //   枪身既会缩得过小、中心也会偏移 —— 这是之前怎么调位置都别扭的根因。
    model.updateMatrixWorld(true);
    const rifleBox = new THREE.Box3();
    const meshBox = new THREE.Box3();
    let hasRifle = false;
    model.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      o.geometry.computeBoundingBox();
      if (!o.geometry.boundingBox) return;
      meshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      rifleBox.union(meshBox);
      hasRifle = true;
    });
    if (!hasRifle) rifleBox.set(new THREE.Vector3(-0.05, -0.05, -0.5), new THREE.Vector3(0.05, 0.05, 0.5));
    this._naturalSize = rifleBox.getSize(new THREE.Vector3());
    this._naturalCenter = rifleBox.getCenter(new THREE.Vector3());
    this.rifleBox = rifleBox.clone();
    this._applyViewTransform();

    this.pivot.add(model);
    this.model = model;

    this.meshNames = [];
    model.traverse((o) => {
      if (o.isMesh) this.meshNames.push(o.name);
    });

    this._refreshMuzzle();
    this.pivot.position.copy(this.basePos);
    this.pivot.rotation.copy(this.baseRot);
  }

  /**
   * 按 viewConfig 重算模型缩放与偏移
   * - 最长边归一到 view.scale
   * - 模型中心对齐到 pivot 原点，再叠加 offset（让握把落在 pivot 附近）
   */
  _applyViewTransform() {
    const v = this.viewConfig;
    const size = this._naturalSize;
    const center = this._naturalCenter;
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const scale = (v.scale || 0.66) / maxDim;
    const off = v.offset || { x: 0, y: 0, z: 0 };

    this.model.scale.setScalar(scale);
    this.model.position.set(
      -center.x * scale + (off.x || 0),
      -center.y * scale + (off.y || 0),
      -center.z * scale + (off.z || 0)
    );
    this._refreshMuzzle();
  }

  /**
   * 枪口锚点：模型朝向 -Z，枪口在变换后包围盒的最前端（min.z）。
   * ⚠ 不能用 Box3.setFromObject 取——那是**世界坐标**，相机在场景里一移动就全错。
   *   这里按「原始包围盒 × 缩放 + 偏移」解析计算，结果始终在 pivot 本地坐标系。
   */
  _refreshMuzzle() {
    if (!this.model) return;
    const s = this.model.scale.x;
    const n = this._naturalSize;
    const off = this.viewConfig.offset || { x: 0, y: 0, z: 0 };
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

  /** 切换武器：调整模型缩放 / 位置 / 旋转 */
  setWeapon(weaponConfig) {
    const v = weaponConfig.view;
    this.basePos.set(v.position.x, v.position.y, v.position.z);
    this.baseRot.set(v.rotation.x, v.rotation.y, v.rotation.z);
    if (this.model) this.model.scale.setScalar(v.scale);
    this.pivot.position.copy(this.basePos);
    this.pivot.rotation.copy(this.baseRot);
    if (this._naturalSize) {
      const n = this._naturalSize;
      const s = v.scale;
      const d = n.z * s;
      const off = v.offset || {};
      this.muzzleLocal.set(
        off.x || 0,
        (off.y || 0) + n.y * s * 0.10,
        (off.z || 0) - d / 2 + 0.01
      );
    }
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
    // 开镜：枪身移到画面中线并抬高到准心位置
    const adsX = 0;
    const adsY = this.basePos.y + 0.075;
    const adsZ = this.basePos.z + 0.03;
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
