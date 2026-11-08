/**
 * 投掷物系统（v0.1）：手雷 / 燃烧瓶
 *
 * - 按 G / H 进入投掷态，按住左键蓄力（0 → 1，约 1.2 秒），松开投出
 * - 手雷：抛物线飞行，2 秒引信后爆炸（半径 8 米 / 伤害 120），可连锁点燃油桶
 * - 燃烧瓶：落地碎裂生成火区，持续 5 秒，每秒对区域内敌人与玩家造成 20 伤害
 * - 投掷态下显示抛物线轨迹预览（与实际弹道同一套积分）
 * - 开局各 2 个，物资箱可随机补给
 */
import * as THREE from 'three';

const GRAVITY = -14;
const CHARGE_TIME = 1.2;     // 蓄满所需时间
const SPEED_MIN = 9;
const SPEED_MAX = 23;
const MAX_FLIGHT = 3.0;      // 未落地时的最长飞行时间

export const THROW_KINDS = {
  frag: { id: 'frag', name: '手雷', fuse: 2.0, radius: 8.0, damage: 120 },
  molotov: { id: 'molotov', name: '燃烧瓶', radius: 2.4, duration: 5.0, dps: 20 },
};

export class ThrowSystem {
  constructor({ scene, collision, camera, player, enemies, effects, audio, explosions }) {
    this.scene = scene;
    this.collision = collision;
    this.camera = camera;
    this.player = player;
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.explosions = explosions || null;

    this.counts = { frag: 2, molotov: 2 };
    this.mode = null;        // null | 'frag' | 'molotov'
    this.charge = 0;
    this.charging = false;

    this.projectiles = [];
    this.zones = [];

    this._tmpDir = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);

    // 共用几何体 / 材质（投射物）
    this.fragGeo = new THREE.SphereGeometry(0.11, 10, 8);
    this.fragMat = new THREE.MeshStandardMaterial({ color: 0x3f5a34, roughness: 0.7, metalness: 0.3 });
    this.molotovGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.22, 8);
    this.molotovMat = new THREE.MeshStandardMaterial({
      color: 0xd07a30, emissive: 0x552200, roughness: 0.5, metalness: 0.2,
    });

    this._buildPreview();
  }

  // ---------------- 轨迹预览 ----------------
  _buildPreview() {
    const MAX = 48;
    this.previewCount = MAX;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    this.previewLine = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: 0xffb020, transparent: true, opacity: 0.55, depthWrite: false,
      })
    );
    this.previewLine.frustumCulled = false;
    this.previewLine.visible = false;
    this.scene.add(this.previewLine);
  }

  /** 抛射初速（预览与真实投掷共用，保证所见即所得） */
  _launchVelocity(dir, charge) {
    const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * charge;
    return dir.clone().multiplyScalar(speed).addScaledVector(this._up, 2.0 + charge * 1.5);
  }

  _origin() {
    const dir = this.camera.getWorldDirection(this._tmpDir).clone();
    const pos = this.camera.position.clone()
      .addScaledVector(dir, 0.45)
      .addScaledVector(this._up, -0.12);
    return { pos, dir };
  }

  _updatePreview() {
    const { pos, dir } = this._origin();
    const vel = this._launchVelocity(dir, this.charge);
    const p = pos.clone();
    const position = this.previewLine.geometry.attributes.position;
    let count = 0;
    const step = 0.045;

    for (let i = 0; i < this.previewCount; i++) {
      position.setXYZ(i, p.x, p.y, p.z);
      count += 1;

      const next = p.clone().addScaledVector(vel, step);
      vel.y += GRAVITY * step;

      // 地面 / 墙体截断，预览不穿墙
      if (next.y <= 0.05) break;
      const seg = next.clone().sub(p);
      const len = seg.length();
      if (len > 0.001) {
        const hit = this.collision.raycast(p, seg.normalize(), len);
        if (hit) {
          if (count < this.previewCount) {
            position.setXYZ(count, hit.point.x, hit.point.y, hit.point.z);
            count += 1;
          }
          break;
        }
      }
      p.copy(next);
    }

    position.needsUpdate = true;
    this.previewLine.geometry.setDrawRange(0, count);
    this.previewLine.visible = count > 1;
  }

  _hidePreview() {
    this.previewLine.visible = false;
  }

  // ---------------- 模式切换 ----------------
  /** 进入 / 退出投掷态；数量不足返回失败原因 */
  toggleMode(kind) {
    const def = THROW_KINDS[kind];
    if (!def) return { ok: false, message: '未知道具' };
    if (this.counts[kind] <= 0) {
      this.mode = null;
      this._hidePreview();
      return { ok: false, message: `${def.name}已用完` };
    }
    this.mode = this.mode === kind ? null : kind;
    if (!this.mode) {
      this.charge = 0;
      this.charging = false;
      this._hidePreview();
    }
    return { ok: true, mode: this.mode, message: this.mode ? `已切到${def.name}，按住左键蓄力` : '已取消投掷' };
  }

  /** 中断投掷态（暂停 / 回大厅 / 打开面板） */
  cancel() {
    this.mode = null;
    this.charge = 0;
    this.charging = false;
    this._hidePreview();
  }

  /**
   * 每帧投掷瞄准：按住左键蓄力，松开投出
   * @param {number} dt
   * @param {boolean} holding
   */
  updateAim(dt, holding) {
    if (!this.mode) {
      this.charging = false;
      this.charge = 0;
      this._hidePreview();
      return;
    }

    if (holding) {
      this.charging = true;
      this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
      this._updatePreview();
    } else if (this.charging) {
      // 松开：投出
      this.charging = false;
      this._throw();
      this.charge = 0;
      this._hidePreview();
    } else {
      this._updatePreview();
    }
  }

  // ---------------- 投掷 ----------------
  _throw() {
    const kind = this.mode;
    if (!kind || this.counts[kind] <= 0) return;

    this.counts[kind] -= 1;
    const { pos, dir } = this._origin();
    const def = THROW_KINDS[kind];

    const mesh = new THREE.Mesh(
      kind === 'frag' ? this.fragGeo : this.molotovGeo,
      kind === 'frag' ? this.fragMat : this.molotovMat
    );
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);

    this.projectiles.push({
      kind,
      def,
      mesh,
      pos: pos.clone(),
      vel: this._launchVelocity(dir, this.charge),
      fuse: def.fuse || 0,
      life: 0,
      resting: false,
      spin: kind === 'frag'
        ? new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8)
        : new THREE.Vector3(1.2, 0.5, 0.8),
    });

    if (this.audio) this.audio.play('casing1', { volume: 0.5, rate: 0.8 });

    // 扔完后没有存量就自动退出投掷态
    if (this.counts[kind] <= 0) this.mode = null;
  }

  // ---------------- 每帧更新 ----------------
  update(dt) {
    this._updateProjectiles(dt);
    this._updateZones(dt);
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life += dt;
      let impact = null;

      if (!p.resting) {
        const step = p.vel.clone().multiplyScalar(dt);
        const len = step.length();

        if (len > 0.001) {
          const dir = step.clone().normalize();
          const hit = this.collision.raycast(p.pos, dir, len + 0.05);
          if (hit) {
            p.pos.copy(hit.point).addScaledVector(hit.normal, 0.05);
            impact = 'wall';
          } else {
            p.pos.add(step);
          }
        }
        p.vel.y += GRAVITY * dt;

        if (!impact && p.pos.y <= 0.11) {
          p.pos.y = 0.11;
          impact = 'ground';
        }
        p.mesh.position.copy(p.pos);
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
      }

      // 手雷：撞击后停下继续计时，引信到期爆炸
      if (p.kind === 'frag') {
        if (impact) {
          p.resting = true;
          p.vel.set(0, 0, 0);
        }
        p.fuse -= dt;
        if (p.fuse <= 0) {
          this._explodeFrag(p);
          this._removeProjectile(i);
          continue;
        }
        continue;
      }

      // 燃烧瓶：第一次撞击即碎裂；飞太久也强制碎裂
      if (impact) {
        this._breakMolotov(p);
        this._removeProjectile(i);
        continue;
      }
      if (p.life >= MAX_FLIGHT) {
        this._breakMolotov(p);
        this._removeProjectile(i);
      }
    }
  }

  _explodeFrag(p) {
    const center = p.pos.clone();
    const def = p.def;

    // 敌人：距离衰减伤害
    if (this.enemies && this.enemies.enemies) {
      for (const e of this.enemies.enemies) {
        if (!e || e.dead || !e.root || !e.root.visible) continue;
        const d = e.position.distanceTo(center);
        if (d > def.radius) continue;
        const mul = 1 - d / def.radius;
        e.takeDamage(def.damage * mul);
      }
    }

    // 玩家：同样按距离衰减（贴着爆炸会被炸伤）
    if (this.player && !this.player.dead && this.player.takeDamage) {
      const d = this.player.position.distanceTo(center);
      if (d <= def.radius) {
        const mul = 1 - d / def.radius;
        this.player.takeDamage(Math.round(def.damage * mul));
      }
    }

    // 连锁引爆附近油桶 / 汽车
    this.explosions?.igniteWithin(center, def.radius);

    if (this.effects) {
      this.effects.spawnExplosion(center, def.radius);
      this.effects.spawnSmoke(center, def.radius);
      this.effects.spawnBurnMark(center, def.radius * 0.9);
    }
    if (this.audio) {
      if (this.audio.playSfx) this.audio.playSfx('boom');
      const dist = this.player ? this.player.position.distanceTo(center) : 20;
      this.audio.play('fire2', {
        volume: this.audio.distanceVolume(dist) * 1.3,
        rate: 0.26 + Math.random() * 0.08,
      });
    }
  }

  _breakMolotov(p) {
    this._createFireZone(p.pos.clone(), p.def);
    if (this.audio) {
      if (this.audio.playSfx) this.audio.playSfx('fire');
      this.audio.play('casing1', { volume: 0.6, rate: 0.9 });
    }
  }

  _createFireZone(point, def) {
    const ground = new THREE.Vector3(point.x, 0.03, point.z);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(def.radius, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff6a20, transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(ground);

    const light = new THREE.PointLight(0xff7a30, 1.8, def.radius * 3.2, 2);
    light.position.set(ground.x, 1.0, ground.z);

    const root = new THREE.Group();
    root.add(disc);
    root.add(light);
    this.scene.add(root);

    this.zones.push({
      root, disc, light, def,
      point: ground,
      life: def.duration,
      tick: 0,
    });
  }

  _updateZones(dt) {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.life -= dt;
      z.tick -= dt;

      // 火光闪烁 + 末段淡出
      z.light.intensity = 1.5 + Math.random() * 0.7;
      const k = Math.max(0, Math.min(1, z.life / 1.2));
      z.disc.material.opacity = 0.42 * k;

      if (z.tick <= 0) {
        z.tick = 0.25;
        const tickDmg = z.def.dps * 0.25;
        if (this.enemies && this.enemies.enemies) {
          for (const e of this.enemies.enemies) {
            if (!e || e.dead || !e.root || !e.root.visible) continue;
            const dx = e.position.x - z.point.x;
            const dz = e.position.z - z.point.z;
            if (Math.hypot(dx, dz) <= z.def.radius) e.takeDamage(tickDmg);
          }
        }
        if (this.player && !this.player.dead) {
          const dx = this.player.position.x - z.point.x;
          const dz = this.player.position.z - z.point.z;
          if (Math.hypot(dx, dz) <= z.def.radius) this.player.takeDamage(tickDmg);
        }
      }

      if (z.life <= 0) {
        this.scene.remove(z.root);
        z.disc.geometry.dispose();
        z.disc.material.dispose();
        this.zones.splice(i, 1);
      }
    }
  }

  _removeProjectile(index) {
    const p = this.projectiles[index];
    if (!p) return;
    this.scene.remove(p.mesh);
    this.projectiles.splice(index, 1);
  }

  // ---------------- 补给 / 重置 ----------------
  /** 物资箱：随机补一个投掷物，返回实际补给种类 */
  grantCache() {
    const kinds = ['frag', 'molotov'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    this.counts[kind] += 1;
    return kind;
  }

  /** 新局重置：清空投射物与火区，数量回到开局 2/2 */
  reset() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.projectiles.length = 0;
    for (const z of this.zones) {
      this.scene.remove(z.root);
      z.disc.geometry.dispose();
      z.disc.material.dispose();
    }
    this.zones.length = 0;
    this.counts = { frag: 2, molotov: 2 };
    this.cancel();
  }
}
