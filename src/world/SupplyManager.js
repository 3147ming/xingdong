/**
 * 补给点系统（v0.3）：资源点 / 弹药补给 / 物资补给
 *
 * - 地图上散布若干补给点（SUPPLY.points），分四类：
 *   ammo 弹药箱 / med 医疗包 / armor 护甲板 / cache 综合物资箱
 * - 玩家走近（SUPPLY.pickupRadius）自动拾取，无需按键；
 * - 拾取后进入冷却（SUPPLY.respawnSec）再重新刷新，循环可用；
 * - 视觉：发光补给箱 + 上下浮动 + 垂直光柱，远处可见，方便规划路线。
 */
import * as THREE from 'three';
import { SUPPLY, DROP } from '../config/weapon.js';

export class SupplyManager {
  /**
   * @param opts { scene, player, gun, playerHealth, hud, audio }
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.player = opts.player;
    this.gun = opts.gun;
    this.playerHealth = opts.playerHealth;
    this.hud = opts.hud;
    this.audio = opts.audio;
    // 物资箱随机投掷物补给（由 Game 注入 ThrowSystem）
    this.onThrowable = opts.onThrowable || null;
    // 行囊：状态满员时拾取的补给自动存入（由 Game 注入 InventoryUI）
    this.inventory = opts.inventory || null;
    // 科研·后勤：掉落率倍率（1 = 基础）
    this.dropChanceMul = 1;

    this.group = new THREE.Group();
    this.points = [];
    this.drops = [];         // 敌人死亡吐出来的临时掉落物
    this.groupDrops = new THREE.Group();
    this.defs = (opts.points && opts.points.length) ? opts.points : SUPPLY.points;
    this._time = 0;
    this.autoPickup = true;   // P 键可切换：关闭后需要按 F 手动拾取

    this._buildPoints();
    this.scene.add(this.group);
    this.scene.add(this.groupDrops);
  }

  /** 切换自动拾取（关闭后靠近补给不会自动拿走） */
  setAutoPickup(on) {
    this.autoPickup = !!on;
  }

  /** 切换地图时重建补给点（守城领地使用自己的点位） */
  setPoints(defs) {
    this.defs = (defs && defs.length) ? defs : SUPPLY.points;
    this.group.clear();
    this.points.length = 0;
    this._buildPoints();
  }

  _buildPoints() {
    const typeEntries = SUPPLY.types;
    for (const def of this.defs) {
      const cfg = typeEntries[def.type] || typeEntries.ammo;
      const root = new THREE.Group();
      root.position.set(def.x, 0, def.z);

      // 补给箱本体
      const boxMat = new THREE.MeshStandardMaterial({
        color: cfg.color, roughness: 0.55, metalness: 0.25,
        emissive: cfg.color, emissiveIntensity: 0.22,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.5, 0.52), boxMat);
      box.position.y = 0.32;
      box.castShadow = true;
      box.receiveShadow = true;
      root.add(box);

      // 箱盖十字绑带（识别色）
      const strapMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
      const strapA = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.54, 0.08), strapMat);
      strapA.position.y = 0.32;
      const strapB = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.54, 0.56), strapMat);
      strapB.position.y = 0.32;
      root.add(strapA, strapB);

      // 垂直光柱（远处可见）
      const beamMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.16,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 10, 1, true), beamMat);
      beam.position.y = 1.7;
      root.add(beam);

      // 顶部浮标
      const orbMat = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.85 });
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), orbMat);
      orb.position.y = 0.85;
      root.add(orb);

      // 地面光圈
      const ringMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.3,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 24), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      root.add(ring);

      this.group.add(root);
      this.points.push({
        type: def.type,
        cfg,
        root, box, beam, orb, ring,
        cooldown: 0,       // >0 = 冷却中（已拾取待刷新）
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** 开局 / 重开：全部补给点复位 + 清掉落物 */
  reset() {
    for (const p of this.points) {
      p.cooldown = 0;
      p.root.visible = true;
    }
    for (const d of this.drops) this.groupDrops.remove(d.root);
    this.drops.length = 0;
  }

  update(dt) {
    this._time += dt;
    const player = this.player;
    if (!player || player.dead) return;

    for (const p of this.points) {
      // 浮动与呼吸动画
      const bob = Math.sin(this._time * 2.1 + p.phase);
      p.orb.position.y = 0.85 + bob * 0.09;
      p.beam.material.opacity = 0.13 + (bob * 0.5 + 0.5) * 0.08;
      p.ring.rotation.z += dt * 0.55;

      if (p.cooldown > 0) {
        p.cooldown -= dt;
        if (p.cooldown <= 0) {
          p.cooldown = 0;
          p.root.visible = true;   // 冷却结束重新刷新
        }
        continue;
      }

      if (!this.autoPickup) continue;
      this._tryPickup(p);
    }

    // --- 敌人掉落物 ---
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      d.root.position.y = d._baseY + Math.sin(this._time * 3.5 + d.phase) * 0.08;
      // 落地淡出（最后 2 秒渐暗）
      const remain = d.life;
      if (remain < 2 && d.body.material) {
        d.body.material.transparent = true;
        d.body.material.opacity = Math.max(0, remain / 2);
      }
      // 出生时的小爆炸粒子：膨胀 + 淡出
      if (d._puffTime > 0 && d.puff) {
        d._puffTime -= dt;
        const k = Math.max(0, 1 - d._puffTime / 0.32);
        const s = 1 + k * 2.5;
        d.puff.scale.set(s, s, s);
        d.puff.material.opacity = Math.max(0, 0.7 * (1 - k));
      } else if (d.puff) {
        d.root.remove(d.puff);
        d.puff = null;
      }
      const dx = player.position.x - d.root.position.x;
      const dz = player.position.z - d.root.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= SUPPLY.pickupRadius && (this.autoPickup || d._fkey)) {
        this._consumeDrop(d);
        this.groupDrops.remove(d.root);
        this.drops.splice(i, 1);
        continue;
      }
      if (d.life <= 0) {
        this.groupDrops.remove(d.root);
        this.drops.splice(i, 1);
      }
    }
  }

  /** F 键手动拾取：拿走身边最近的可用补给 */
  pickupNearest() {
    const player = this.player;
    if (!player || player.dead) return false;
    // 动态掉落物优先（因为会消失）
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      const dx = player.position.x - d.root.position.x;
      const dz = player.position.z - d.root.position.z;
      if (Math.hypot(dx, dz) <= SUPPLY.pickupRadius) {
        this._consumeDrop(d);
        this.groupDrops.remove(d.root);
        this.drops.splice(i, 1);
        return true;
      }
    }
    for (const p of this.points) {
      if (p.cooldown > 0 || !p.root.visible) continue;
      if (this._inRange(p) && this._tryPickup(p)) return true;
    }
    return false;
  }

  _inRange(p) {
    const dx = this.player.position.x - p.root.position.x;
    const dz = this.player.position.z - p.root.position.z;
    return Math.hypot(dx, dz) <= SUPPLY.pickupRadius;
  }

  /** 补给类型 → 行囊物品 id（满员溢出时存入行囊） */
  _inventoryType(cfg) {
    if (cfg.heal > 0) return 'medkit';
    if (cfg.armor > 0) return 'armor';
    if (cfg.ammo > 0) return 'ammo';
    if (cfg.throwable > 0) return 'throwable';
    return null;
  }

  /** 最近可拾取补给的名称（无则 null），用于战斗内 F 交互提示 */
  nearestPrompt() {
    const player = this.player;
    if (!player || player.dead) return null;
    let label = null;
    let best = SUPPLY.pickupRadius;
    for (const d of this.drops) {
      const dist = Math.hypot(player.position.x - d.root.position.x, player.position.z - d.root.position.z);
      if (dist <= best) { best = dist; label = d.cfg.label; }
    }
    for (const p of this.points) {
      if (p.cooldown > 0 || !p.root.visible) continue;
      const dist = Math.hypot(player.position.x - p.root.position.x, player.position.z - p.root.position.z);
      if (dist <= best) { best = dist; label = p.cfg.label; }
    }
    return label;
  }

  /** 尝试拾取单个补给点；成功返回 true */
  _tryPickup(p) {
    if (!this._inRange(p)) return false;

    const cfg = p.cfg;
    let took = false;
    if (cfg.ammo > 0 && this.gun) {
      this.gun.addSupply(cfg.ammo);
      took = true;
    }
    if (cfg.heal > 0 && this.playerHealth) {
      const before = this.playerHealth.health;
      this.playerHealth.heal(cfg.heal);
      if (this.playerHealth.health > before) took = true;
    }
    if (cfg.armor > 0 && this.playerHealth) {
      const before = this.playerHealth.armor;
      this.playerHealth.addArmor(cfg.armor);
      if (this.playerHealth.armor > before) took = true;
    }
    if (cfg.throwable > 0 && this.onThrowable) {
      this.onThrowable(cfg.throwable);
      took = true;
    }

    // 状态满员：不浪费，转存行囊
    let stored = false;
    if (!took && this.inventory) {
      const type = this._inventoryType(cfg);
      if (type) stored = this.inventory.add(type);
    }
    if (!took && !stored) return false;

    p.cooldown = SUPPLY.respawnSec;
    p.root.visible = false;
    if (this.audio) this.audio.play('reload', { volume: 0.5, rate: 1.15 });
    if (this.hud) {
      if (stored && !took) this.hud.showSupplyToast(`已存入行囊：${cfg.label}`, '按 B 打开行囊使用');
      else this.hud.showSupplyToast(cfg.label, cfg.hint);
    }
    return true;
  }

  // ---------------- 敌人死亡掉落 ----------------
  /**
   * 根据变体的 DROP 掉落表在地面吐出 0~N 个补给箱。
   * @param {THREE.Vector3} pos 死亡位置
   * @param {object} variant 敌人变体定义（含 id 字段，如 'walker','boss'）
   */
  spawnDrop(pos, variant) {
    const table = (DROP.byType && DROP.byType[variant?.id]) || null;
    if (!table || !table.drops?.length) return;
    for (const d of table.drops) {
      if (Math.random() > d.chance) continue;
      const angle = Math.random() * Math.PI * 2;
      const rad = 0.4 + Math.random() * 0.6;
      const x = pos.x + Math.cos(angle) * rad;
      const z = pos.z + Math.sin(angle) * rad;
      this._createDrop(x, z, d.type);
    }
  }

  _createDrop(x, z, type) {
    const cfg = SUPPLY.types[type] || SUPPLY.types.ammo;
    const root = new THREE.Group();
    root.position.set(x, 0, z);

    // 小体积落地盒（比地图静态补给小一号，暗示"临时掉落"）
    const size = 0.28;
    const boxMat = new THREE.MeshStandardMaterial({
      color: cfg.color, roughness: 0.6, metalness: 0.35,
      emissive: cfg.color, emissiveIntensity: 0.6,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.8, size), boxMat);
    body.position.y = 0.18;
    body.castShadow = true;
    body.receiveShadow = true;
    root.add(body);

    // 地面光环
    const ringMat = new THREE.MeshBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.4, 18), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    root.add(ring);

    // 出生时一个小爆炸粒子（用 sphere 快速放大 + 淡出）
    const puffMat = new THREE.MeshBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0.7,
      depthWrite: false,
    });
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), puffMat);
    puff.position.y = 0.12;
    root.add(puff);

    this.groupDrops.add(root);
    const drop = {
      root, body, ring, puff, cfg,
      life: DROP.lifetime,
      _baseY: 0,
      phase: Math.random() * Math.PI * 2,
      _puffTime: 0.32,
    };
    this.drops.push(drop);
  }

  _consumeDrop(d) {
    const cfg = d.cfg;
    let took = false;
    if (cfg.ammo > 0 && this.gun) {
      this.gun.addSupply(cfg.ammo);
      took = true;
    }
    if (cfg.heal > 0 && this.playerHealth) {
      const before = this.playerHealth.health;
      this.playerHealth.heal(cfg.heal);
      if (this.playerHealth.health > before) took = true;
    }
    if (cfg.armor > 0 && this.playerHealth) {
      const before = this.playerHealth.armor;
      this.playerHealth.addArmor(cfg.armor);
      if (this.playerHealth.armor > before) took = true;
    }
    // 状态满员：转存行囊
    let stored = false;
    if (!took && this.inventory) {
      const type = this._inventoryType(cfg);
      if (type) stored = this.inventory.add(type);
    }
    if (this.audio) this.audio.play('reload', { volume: 0.55, rate: 1.25 });
    if (this.hud && took) this.hud.showSupplyToast(`拾取 ${cfg.label}`, cfg.hint);
    else if (this.hud && stored) this.hud.showSupplyToast(`已存入行囊：${cfg.label}`, '按 B 打开行囊使用');
  }
}
