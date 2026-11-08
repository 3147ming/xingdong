/**
 * 陷阱与炮塔系统。
 *
 * 流程：波间商店购买 → 手持蓝图 → 走到位置按 F 放置。
 * 所有装置都有生命值，丧尸贴身会持续拆毁它。
 *
 * 行为：
 *  - 阔剑地雷：敌人进入触发半径即引爆（范围伤害，并连锁点燃油桶）
 *  - 火焰陷阱：敌人靠近时喷火一段时间，区域内持续灼烧
 *  - 电网：范围内敌人持续被麻痹（减速 95%）
 *  - 自动炮塔：360° 索敌，视线内自动射击
 */
import * as THREE from 'three';
import { TRAPS } from '../config/traps.js';

const PLACE_DIST = 2.4;      // 放置在玩家前方多少米
const TRAP_MIN_GAP = 1.4;    // 两个装置之间的最小间距
const ENEMY_BREAK_RADIUS = 1.7;  // 丧尸拆装置的距离
const ENEMY_BREAK_DPS = 14;      // 每只丧尸的拆解速度

export class TrapSystem {
  constructor({ scene, collision, camera, player, enemies, effects, audio, explosions, hud }) {
    this.scene = scene;
    this.collision = collision;
    this.camera = camera;
    this.player = player;
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.explosions = explosions || null;
    this.hud = hud;

    this.traps = [];
    this.blueprint = null;   // 已购买但尚未放置的装置 id

    this._dir = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // ---------------- 蓝图 ----------------
  /** 购买后持有蓝图（同时只能拿一个） */
  setBlueprint(kind) {
    if (!TRAPS[kind]) return false;
    this.blueprint = kind;
    return true;
  }

  clearBlueprint() {
    this.blueprint = null;
  }

  get blueprintName() {
    return this.blueprint ? TRAPS[this.blueprint].name : '';
  }

  /** 在玩家前方放置当前蓝图；返回 { ok, message } */
  tryPlace() {
    if (!this.blueprint) return { ok: false, message: '尚未购买装置' };
    const def = TRAPS[this.blueprint];

    const dir = this.camera.getWorldDirection(this._dir).clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) return { ok: false, message: '朝向无效' };
    dir.normalize();

    const point = this.player.position.clone().addScaledVector(dir, PLACE_DIST);
    point.y = 0;

    for (const t of this.traps) {
      if (t.position.distanceTo(point) < TRAP_MIN_GAP) {
        return { ok: false, message: '与其他装置距离太近' };
      }
    }
    if (!this.collision.canFit(point, 0.35, 0.6)) {
      return { ok: false, message: '该位置被障碍物占用' };
    }

    this._addTrap(this.blueprint, point);
    this.blueprint = null;
    return { ok: true, message: `${def.name} 已布置` };
  }

  // ---------------- 装置构建 ----------------
  _addTrap(kind, point) {
    const def = TRAPS[kind];
    const root = new THREE.Group();
    root.position.copy(point);

    const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.62, metalness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f34, roughness: 0.8, metalness: 0.4 });

    let head = null;
    let lamp = null;
    let light = null;

    if (kind === 'mine') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.36), dark);
      body.position.y = 0.06;
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xcc0000, emissiveIntensity: 1.2 });
      lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), lampMat);
      lamp.position.set(0, 0.15, 0);
      const tripod = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), mat);
      tripod.position.set(0.18, 0.08, 0.1);
      root.add(body, lamp, tripod);
    } else if (kind === 'flame') {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.5, 10), mat);
      tank.position.y = 0.25;
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.3, 8), dark);
      nozzle.rotation.x = -0.9;
      nozzle.position.set(0, 0.52, -0.2);
      root.add(tank, nozzle);
      light = new THREE.PointLight(0xff7a30, 0, 6, 2);
      light.position.set(0, 0.65, -0.3);
      root.add(light);
    } else if (kind === 'shock') {
      const postMat = new THREE.MeshStandardMaterial({ color: 0x2e7fa8, roughness: 0.5, metalness: 0.5, emissive: 0x0a2a3a });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.0, 8), postMat);
        post.position.set(side * 0.7, 0.5, 0);
        root.add(post);
      }
      for (let i = 0; i < 3; i++) {
        const wire = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.02, 0.02), postMat);
        wire.position.set(0, 0.22 + i * 0.28, 0);
        root.add(wire);
      }
      light = new THREE.PointLight(0x3fa8ff, 1.0, 5, 2);
      light.position.set(0, 0.6, 0);
      root.add(light);
    } else if (kind === 'turret') {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.5, 10), mat);
      base.position.y = 0.25;
      head = new THREE.Group();
      head.position.y = 0.72;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.36), dark);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.44, 8), dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.03, -0.32);
      head.add(body, barrel);
      root.add(base, head);
      light = new THREE.PointLight(0xffc070, 0.4, 3, 2);
      light.position.set(0, 0.9, 0);
      root.add(light);
    }

    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    this.scene.add(root);

    this.traps.push({
      kind, def, root,
      position: point.clone(),
      hp: def.hp,
      maxHp: def.hp,
      cooldown: 0,
      active: 0,
      spark: 0,
      head,
      lamp,
      light,
    });
  }

  // ---------------- 每帧更新 ----------------
  update(dt) {
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const t = this.traps[i];
      this._damageByEnemies(t, dt);

      if (t.hp <= 0) {
        this._destroyTrap(i, true);
        continue;
      }

      if (t.kind === 'mine') this._updateMine(t);
      else if (t.kind === 'flame') this._updateFlame(t, dt);
      else if (t.kind === 'shock') this._updateShock(t, dt);
      else if (t.kind === 'turret') this._updateTurret(t, dt);
    }
  }

  /** 丧尸贴身拆装置 */
  _damageByEnemies(t, dt) {
    if (!this.enemies || !this.enemies.enemies) return;
    let count = 0;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root || !e.root.visible) continue;
      const dx = e.position.x - t.position.x;
      const dz = e.position.z - t.position.z;
      if (Math.hypot(dx, dz) <= ENEMY_BREAK_RADIUS) count += 1;
    }
    if (count > 0) {
      t.hp -= count * ENEMY_BREAK_DPS * dt;
      if (t.root) t.root.rotation.y += dt * 0.3 * count;
    }
  }

  _updateMine(t) {
    const target = this._firstEnemyWithin(t.position, t.def.triggerRadius);
    // 红灯闪烁
    if (t.lamp) {
      t.lamp.material.emissiveIntensity = 0.6 + Math.sin(performance.now() * 0.006) * 0.5;
    }
    if (!target) return;

    const center = t.position.clone();
    center.y += 0.4;
    if (this.enemies && this.enemies.enemies) {
      for (const e of this.enemies.enemies) {
        if (!e || e.dead || !e.root || !e.root.visible) continue;
        const d = e.position.distanceTo(center);
        if (d > t.def.radius) continue;
        const mul = 1 - d / t.def.radius;
        e.takeDamage(t.def.damage * mul);
      }
    }
    this.explosions?.igniteWithin(center, t.def.radius);
    if (this.effects) {
      this.effects.spawnExplosion(center, t.def.radius);
      this.effects.spawnSmoke(center, t.def.radius);
      this.effects.spawnBurnMark(center, t.def.radius * 0.9);
    }
    if (this.audio) {
      if (this.audio.playSfx) this.audio.playSfx('boom');
      this.audio.play('fire2', { volume: 0.9, rate: 0.3 });
    }

    this._destroyTrap(this.traps.indexOf(t), false);
  }

  _updateFlame(t, dt) {
    t.cooldown -= dt;

    if (t.active > 0) {
      t.active -= dt;
      // 持续灼烧
      if (this.enemies && this.enemies.enemies) {
        for (const e of this.enemies.enemies) {
          if (!e || e.dead || !e.root || !e.root.visible) continue;
          const dx = e.position.x - t.position.x;
          const dz = e.position.z - t.position.z;
          if (Math.hypot(dx, dz) <= t.def.radius) e.takeDamage(t.def.dps * dt);
        }
      }
      // 喷火粒子
      t.spark -= dt;
      if (t.spark <= 0 && this.effects) {
        t.spark = 0.09;
        this._aim.set(
          t.position.x + (Math.random() - 0.5) * 0.6,
          0.6 + Math.random() * 0.5,
          t.position.z + (Math.random() - 0.5) * 0.6
        );
        this.effects.spawnMuzzleFlash(this._aim, this._up);
      }
      if (t.light) t.light.intensity = 1.2 + Math.random() * 0.8;
      if (t.active <= 0 && t.light) t.light.intensity = 0;
      return;
    }

    if (t.light) t.light.intensity = 0;
    if (t.cooldown > 0) return;
    if (!this._firstEnemyWithin(t.position, t.def.triggerRadius)) return;

    t.active = t.def.duration;
    t.cooldown = t.def.duration + t.def.cooldown;
    if (this.audio) {
      if (this.audio.playSfx) this.audio.playSfx('fire');
      this.audio.play('fire2', { volume: 0.7, rate: 0.5 });
    }
  }

  _updateShock(t, dt) {
    t.spark -= dt;
    let hit = 0;
    if (this.enemies && this.enemies.enemies) {
      for (const e of this.enemies.enemies) {
        if (!e || e.dead || !e.root || !e.root.visible) continue;
        const dx = e.position.x - t.position.x;
        const dz = e.position.z - t.position.z;
        if (Math.hypot(dx, dz) > t.def.triggerRadius) continue;
        e.applyStatus('slow', t.def.stun, 0.05);
        hit += 1;
      }
    }
    if (t.light) {
      t.light.intensity = hit > 0 ? 1.2 + Math.random() * 1.0 : 0.35;
    }
  }

  _updateTurret(t, dt) {
    t.cooldown -= dt;
    if (!t.head) return;

    const target = this._nearestEnemy(t.position, t.def.radius);
    if (!target) return;

    const dx = target.position.x - t.position.x;
    const dz = target.position.z - t.position.z;
    const yaw = Math.atan2(-dx, -dz);
    let diff = (yaw - t.head.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    t.head.rotation.y += diff * Math.min(1, dt * 8);

    if (t.cooldown > 0) return;
    t.cooldown = t.def.fireInterval;

    const from = this._from.set(t.position.x, 0.9, t.position.z).clone();
    const to = this._to.copy(target.position);
    to.y += 1.0;
    if (!this.collision.lineOfSight(from, to)) return;

    target.takeDamage(t.def.damage);
    if (this.effects) {
      this.effects.spawnTracer(from, to, 0.7, 0xffd889);
      this.effects.spawnEnemyHit(to);
    }
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(t.position) : 20;
      this.audio.play('fire2', { volume: this.audio.distanceVolume(dist) * 1.2, rate: 1.1 });
    }
  }

  // ---------------- 查询 ----------------
  _firstEnemyWithin(pos, radius) {
    if (!this.enemies || !this.enemies.enemies) return null;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root || !e.root.visible) continue;
      const dx = e.position.x - pos.x;
      const dz = e.position.z - pos.z;
      if (Math.hypot(dx, dz) <= radius) return e;
    }
    return null;
  }

  _nearestEnemy(pos, radius) {
    if (!this.enemies || !this.enemies.enemies) return null;
    let best = null;
    let bestD = radius;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root || !e.root.visible) continue;
      const d = e.position.distanceTo(pos);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // ---------------- 销毁 / 重置 ----------------
  _destroyTrap(index, byEnemy) {
    const t = this.traps[index];
    if (!t) return;
    this.scene.remove(t.root);
    t.root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    this.traps.splice(index, 1);

    if (byEnemy) {
      if (this.effects) {
        const p = t.position.clone();
        p.y += 0.4;
        this.effects.spawnImpact(p, new THREE.Vector3(0, 1, 0));
      }
      if (this.hud) this.hud.showSupplyToast('装置被拆毁', `${t.def.name} 已被丧尸破坏`);
    }
  }

  /** 换图 / 新局：清掉全部装置与蓝图 */
  reset() {
    for (const t of this.traps) {
      this.scene.remove(t.root);
      t.root.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    }
    this.traps.length = 0;
    this.blueprint = null;
  }
}
