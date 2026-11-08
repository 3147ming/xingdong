/**
 * 场景可爆炸物系统（油桶 + 汽车）。
 *
 * 被子弹击中后进入 2 秒引信状态（引信期持续火花闪烁预警），超时爆炸：
 *   - 范围 5 米，伤害 80（对玩家距离衰减，对敌人固定伤害）
 *   - 连锁反应：范围内未爆炸的油桶/汽车也会被点燃
 *   - 火光 + 浓烟粒子 + 地面焦黑贴花
 */
import * as THREE from 'three';

const FUSE_TIME = 2.0;      // 点燃后引爆延时（秒）
const EXPLODE_RADIUS = 5.0; // 爆炸范围（米）
const EXPLODE_DAMAGE = 80;  // 爆炸伤害

export class ExplosionSystem {
  constructor({ scene, collision, audio, player, enemies, effects }) {
    this.scene = scene;
    this.collision = collision;
    this.audio = audio;
    this.player = player;
    this.enemies = enemies;
    this.effects = effects;

    // 已注册的爆炸物：{ position: Vector3, tag: 'barrel'|'car', state: 'idle'|'fusing'|'exploded', fuseTimer }
    this.explodables = [];

    // 普通子弹可穿透多个爆炸物，避免同一帧连锁递归；此处记录本帧已点燃的
    this._ignitedThisFrame = new Set();
    this._pulsePoint = new THREE.Vector3();
    this._upVec = new THREE.Vector3(0, 1, 0);
  }

  /** 重建爆炸物列表（初始化 / 切换地图时调用） */
  setExplodables(entries = []) {
    this.explodables.length = 0;
    for (const e of entries) this.register(e);
  }

  /** 注册一个可爆炸物（由 MapBuilder 在构建完成后批量调用） */
  register({ position, tag, box }) {
    this.explodables.push({
      position: position.clone(),
      tag,
      box: box || null,
      state: 'idle',
      fuseTimer: 0,
      fusePulse: 0,
    });
  }

  /** 指定点周围的可爆炸物被点燃（火箭 / 手雷等外部爆炸源使用） */
  igniteWithin(point, radius) {
    for (let i = 0; i < this.explodables.length; i++) {
      const o = this.explodables[i];
      if (o.state !== 'idle') continue;
      if (o.position.distanceTo(point) <= radius) this.ignite(i);
    }
  }

  /** 子弹命中爆炸物：按碰撞盒引用精确定位并点燃 */
  igniteByBox(box) {
    if (!box) return;
    const idx = this.explodables.findIndex((o) => o.box === box);
    if (idx >= 0) this.ignite(idx);
  }

  /** 点燃指定索引的爆炸物（子弹击中触发） */
  ignite(index) {
    const obj = this.explodables[index];
    if (!obj || obj.state !== 'idle') return;
    obj.state = 'fusing';
    obj.fuseTimer = FUSE_TIME;
    obj.fusePulse = 0;
    this._ignitedThisFrame.add(index);

    // 点燃音效（低沉金属撞击声）
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(obj.position) : 30;
      this.audio.play('fire2', {
        volume: this.audio.distanceVolume(dist) * 0.9,
        rate: 0.4 + Math.random() * 0.2,
      });
    }
  }

  /** 更新 fuse 计时器与爆炸触发 */
  update(dt) {
    this._ignitedThisFrame.clear();

    for (let i = 0; i < this.explodables.length; i++) {
      const obj = this.explodables[i];
      if (obj.state !== 'fusing') continue;

      obj.fuseTimer -= dt;

      // 引信期火花闪烁：让玩家知道这个桶/车已经被点燃
      obj.fusePulse -= dt;
      if (obj.fusePulse <= 0 && this.effects) {
        obj.fusePulse = 0.16;
        this._pulsePoint.set(obj.position.x, obj.position.y + 1.0, obj.position.z);
        this.effects.spawnMuzzleFlash(this._pulsePoint, this._upVec);
      }

      if (obj.fuseTimer > 0) continue;

      this._explode(i);
    }
  }

  /** 真正爆炸：范围伤害 + 连锁引爆 + 特效 */
  _explode(index) {
    const obj = this.explodables[index];
    obj.state = 'exploded';

    const center = obj.position.clone();
    center.y += 1.0; // 爆炸中心略高于地面，视觉更好

    // ---- 对玩家造成距离衰减伤害 ----
    if (this.player && !this.player.dead && this.player.takeDamage) {
      const d = this.player.position.distanceTo(center);
      if (d <= EXPLODE_RADIUS) {
        const mul = 1 - d / EXPLODE_RADIUS; // 越近伤害越高
        this.player.takeDamage(Math.round(EXPLODE_DAMAGE * mul));
      }
    }

    // ---- 对敌人造成固定伤害 ----
    if (this.enemies && this.enemies.enemies) {
      for (const e of this.enemies.enemies) {
        if (!e || e.dead || !e.root || !e.root.visible) continue;
        if (e.position.distanceTo(center) > EXPLODE_RADIUS) continue;
        if (e.takeDamage(EXPLODE_DAMAGE)) {
          // 爆炸击杀不计入玩家击杀统计（环境杀），但播放击中粒子
          this.effects?.spawnEnemyHit(e.position.clone().add(new THREE.Vector3(0, 1, 0)));
        }
      }
    }

    // ---- 连锁反应：范围内未爆炸的油桶/汽车立即点燃（state 已置 exploded，不会递归）----
    for (let i = 0; i < this.explodables.length; i++) {
      const other = this.explodables[i];
      if (other.state !== 'idle') continue;
      if (other.position.distanceTo(center) <= EXPLODE_RADIUS) this.ignite(i);
    }

    // ---- 视觉特效：火光 + 浓烟 ----
    if (this.effects) {
      this.effects.spawnExplosion(center, EXPLODE_RADIUS);
      this.effects.spawnSmoke(center, EXPLODE_RADIUS);
      this.effects.spawnBurnMark(center, EXPLODE_RADIUS * 0.9);
    }

    // ---- 爆炸音效 ----
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(center) : 30;
      if (this.audio.playSfx) this.audio.playSfx('boom');
      this.audio.play('fire2', {
        volume: this.audio.distanceVolume(dist) * 1.3,
        rate: 0.25 + Math.random() * 0.1,
      });
    }
  }

  /** 重置全部爆炸物（新局开始调用） */
  reset() {
    for (const obj of this.explodables) {
      obj.state = 'idle';
      obj.fuseTimer = 0;
    }
    this._ignitedThisFrame.clear();
  }
}
