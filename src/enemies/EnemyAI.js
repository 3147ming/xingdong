/**
 * 丧尸 AI（v0.3 改造：武装人员 → 丧尸）
 *
 * 状态机：巡逻 → 发现玩家 → 追击 → 攻击 → 死亡
 *   普通丧尸 / 重锤丧尸：近战扑咬（前摇 windup → 范围判定 → 伤害），**没有任何枪械**。
 *   吐酸丧尸：中距离喷吐酸液（非枪械弹道，只做视觉抛物线 + 命中判定）。
 *
 * 同时负责：骨骼动画、受击红闪、血条、命中检测（供玩家射击）。
 */
import * as THREE from 'three';
import { clone as cloneSkeleton } from '../../vendor/three/utils/SkeletonUtils.js';
import { ENEMY } from '../config/weapon.js';

const SPHERE = { body: 0.42, head: 0.22, limb: 0.28 };

export class EnemyAI {
  constructor(opts) {
    this.scene = opts.scene;
    this.assets = opts.assets;
    this.collision = opts.collision;
    this.audio = opts.audio;
    this.player = opts.player;
    this.spawn = opts.spawn.clone();
    this.index = opts.index;
    this.onDeath = opts.onDeath || (() => {});
    this.onSpit = opts.onSpit || (() => {});       // 吐酸弹道视觉
    this.onMelee = opts.onMelee || (() => {});     // 近战挥击视觉/音效
    this.onPlayerHit = opts.onPlayerHit || (() => {});
    this.onExplode = opts.onExplode || (() => {});  // 自爆丧尸爆炸回调
    this.onRoar = opts.onRoar || (() => {});       // howler 嘶吼：触发范围内敌人警觉
    // 每关巡逻点（由 MapBuilder 注入）；未提供时退回全局默认
    this.patrolPoints = opts.patrolPoints || ENEMY.patrolPoints;

    this.position = opts.spawn.clone();
    this.velocity = new THREE.Vector3();
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;
    this.state = 'patrol';               // patrol / alert / chase / attack
    this.dead = false;
    this.deadTimer = 0;
    this.flashTimer = 0;
    this.flinchTimer = 0;
    this.attackTimer = 0;                // 攻击冷却
    this.windupTimer = 0;                // 近战前摇剩余（>0 表示正在抬手）
    this.windupDone = false;
    this.coverTimer = 1.0;
    this.coverStrafe = 0;
    this.coverSign = 1;
    this.alertTimer = 0;
    this.baseScanHeading = this.heading;
    this.scanTime = 0;
    this.lastKnown = new THREE.Vector3();
    this.avoidTimer = 0;
    this.avoidSign = 1;
    this.stuckTimer = 0;
    this.targetPoint = this._pickPatrolPoint();
    this.lastPos = this.position.clone();
    this.fuseStarted = false;   // 自爆丧尸：是否已开始引爆倒计时
    this.fuseTimer = 0;
    this.dashTimer = 0;         // 奔跑者：直线冲刺剩余时间
    this.dashCooldown = 0;      // 奔跑者：冲刺冷却剩余时间
    this.spawnFade = 0;         // 重生淡出剩余时间（>0 表示正在渐显）
    this.chaseLinger = 0;       // 发现玩家后的追击延迟（>0 时仍停留在 alert）
    this._animSwitchTimer = 0;  // 动画切换冷却，避免 run/attack 频繁抖动
    this.roarCooldown = 0;      // howler 嘶吼冷却
    this._hearTimer = 0;        // 听到枪声/子弹落地后的警觉倒计时
    this._hearPos = null;       // 声源位置，听到后朝此处移动
    this._knockCooldown = 0;    // 击退限频：连射时不让击退叠加成瞬移
    this.baseEmissive = new THREE.Color(0x000000);  // 变体基础自发光（远处不至于成为纯黑影）
    this._dashDir = new THREE.Vector3();   // 奔跑者：直线冲刺方向（锁定后不再转向）
    this._poisonCloud = null;              // 胖子：死亡后遗留的毒雾网格
    this._poisonTick = 0;                  // 胖子：毒雾伤害打点计时

    // 波次倍率（EnemyManager.configure 注入）
    this.healthMul = 1;
    this.damageMul = 1;
    this.accuracyMul = 1;
    this.speedMul = 1;

    // 丧尸变体（默认普通丧尸；configure 会按波次 mix 指定）
    this.setVariant('walker');

    this._tmpEye = new THREE.Vector3();
    this._tmpTarget = new THREE.Vector3();

    this._buildModel();
    this._buildHealthBar();
  }

  /** 设定丧尸变体（walker / spitter / brute），重建数值基准 */
  setVariant(id) {
    const v = ENEMY.types[id] || ENEMY.types.walker;
    this.variant = v;
    this.variantId = v.id;
    this.melee = v.melee !== false;      // 只有 spitter 是远程喷吐
    this.maxHealth = v.maxHealth * this.healthMul;
    this.health = this.maxHealth;
    // 基础自发光：让远处丧尸轮廓可辨，不再是纯黑影（"影子飞扑"的观感来源之一）
    const tint = v.tint || 0x9aa878;
    this.baseEmissive.setHex(tint).multiplyScalar(0.10);
    if (this.materials) {
      for (const m of this.materials) {
        m.color.setHex(tint);
        m.emissive.copy(this.baseEmissive);
      }
    }
  }

  /** 波次开始前注入难度倍率（血量 / 伤害 / 精度 / 移速） */
  configure(cfg = {}) {
    this.healthMul = cfg.healthMul ?? 1;
    this.damageMul = cfg.damageMul ?? 1;
    this.accuracyMul = cfg.accuracyMul ?? 1;
    this.speedMul = cfg.speedMul ?? 1;
    this.statusSpeedMul = 1;
    this.burnTimer = 0;
    this.burnDps = 0;
    this.poisonTimer = 0;
    this.poisonDps = 0;
    this.slowTimer = 0;
    if (cfg.variant) this.setVariant(cfg.variant);
    else {
      this.maxHealth = this.variant.maxHealth * this.healthMul;
      this.health = this.maxHealth;
    }
  }

  // ---------------- 模型 ----------------
  _buildModel() {
    this.root = new THREE.Group();
    this.root.position.copy(this.position);
    this.scene.add(this.root);

    const src = this.assets && this.assets.zombieModel;
    if (!src) {
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0x8a2b2b })
      );
      mesh.position.y = 0.9;
      this.root.add(mesh);
      this.materials = [mesh.material];
      this.animations = {};
      return;
    }

    const model = cloneSkeleton(src);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = (ENEMY.height / Math.max(size.y, 0.001)) * (this.variant.scaleMul || 1);
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box2.min.y, -center.z);
    this.root.add(model);
    this.model = model;

    // 丧尸贴图 + 变体染色；每个敌人独立材质，便于受击红闪
    const tex = this.assets.textures && this.assets.textures.zombie;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    }
    this.materials = [];
    const tint = this.variant.tint || 0xffffff;
    model.traverse((o) => {
      if (o.isMesh) {
        const mat = new THREE.MeshStandardMaterial({
          map: tex || null,
          color: tex ? tint : 0x7c3a3a,
          roughness: 0.92,
          metalness: 0.02,
        });
        o.material = mat;
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = false;
        this.materials.push(mat);
      }
    });

    // 动画
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    const clips = this.assets.anims || {};
    const map = { idle: 'idle', walk: 'walk', run: 'run', attack: 'attack', death: 'death' };
    for (const [key, clip] of Object.entries(map)) {
      const c = clips[clip];
      if (!c) continue;
      const action = this.mixer.clipAction(c);
      action.enabled = true;
      this.actions[key] = action;
    }
    this._play('idle');
  }

  _play(name, once = false, force = false, clamp = false) {
    // 动画切换冷却：避免 run/attack 紧邻切换时 fadeIn/Out 叠加导致视觉抖动
    // force=true 用于「前摇结束 / 复活 / 死亡」等必须立即生效的切换
    if (!force && this._animSwitchTimer > 0) return;
    const action = this.actions && this.actions[name];
    if (!action || this.currentAnim === name) return;
    if (this.currentAction) this.currentAction.fadeOut(0.15);
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    // 只有死亡这类定格姿势需要 clamp；攻击动画播完必须能回到 run，
    // 否则 currentAnim 会一直停在 attack，丧尸卡死在原地
    action.clampWhenFinished = clamp;
    action.fadeIn(0.15).play();
    this.currentAction = action;
    this.currentAnim = name;
    this._animSwitchTimer = 0.05;
  }

  // ---------------- 血条 ----------------
  _buildHealthBar() {
    this.barCanvas = document.createElement('canvas');
    this.barCanvas.width = 128;
    this.barCanvas.height = 20;
    this.barTex = new THREE.CanvasTexture(this.barCanvas);
    this.barTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: this.barTex, transparent: true, depthTest: false });
    this.bar = new THREE.Sprite(mat);
    this.bar.scale.set(0.92, 0.14, 1);
    this.bar.position.set(0, ENEMY.height + 0.3, 0);
    this.bar.renderOrder = 5;
    this.root.add(this.bar);
    this._updateBar();
  }

  _updateBar() {
    const ctx = this.barCanvas.getContext('2d');
    const w = 128, h = 20;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    const ratio = Math.max(0, this.health / Math.max(1, this.maxHealth));
    const color = ratio > 0.5 ? '#e23b2e' : ratio > 0.22 ? '#ff8a2b' : '#ff2b2b';
    ctx.fillStyle = color;
    ctx.fillRect(2, 2, (w - 4) * ratio, h - 4);
    this.barTex.needsUpdate = true;
    this.bar.visible = this.health < this.maxHealth && !this.dead;
  }

  // ---------------- 感知 ----------------
  _canSeePlayer() {
    if (!this.player || this.player.dead) return false;
    const eye = this.position.clone();
    eye.y += 1.55;
    const target = this.player.camera.position.clone();
    const dist = eye.distanceTo(target);
    if (dist > ENEMY.sightRange) return false;

    const dir = target.clone().sub(eye).normalize();
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    if (dir.dot(forward) < ENEMY.sightAngle) return false;

    return this.collision.lineOfSight(eye, target);
  }

  /** 听到枪声/子弹落地：敌人会朝声源移动，避免"丧尸对着空地发呆" */
  hearAt(pos) {
    if (!pos) return;
    this._hearTimer = ENEMY.hearTime || 4.0;
    this._hearPos = pos.clone();
    this.lastKnown.copy(pos);
    // 只要不在死状态，听到动静就立刻进入警觉/追击
    if (this.state !== 'dead') {
      if (this.state === 'patrol' || this.state === 'alert') {
        this.state = 'chase';
        this.alertTimer = ENEMY.alertTime;
      }
    }
  }

  /** 增加视野：向四周补充 180° 近距离感知（防止背后被发现也没反应） */
  _canSeePlayerWide() {
    if (!this.player || this.player.dead) return false;
    const eye = this.position.clone();
    eye.y += 1.55;
    const target = this.player.camera.position.clone();
    const dist = eye.distanceTo(target);
    if (dist > ENEMY.sightCloseRange) return false;
    // 近距离不限制朝向，只要有视线就发现
    return this.collision.lineOfSight(eye, target);
  }

  _pickPatrolPoint() {
    const pts = this.patrolPoints;
    let p;
    do {
      p = pts[Math.floor(Math.random() * pts.length)];
    } while (Math.hypot(p.x - this.position.x, p.z - this.position.z) < 2);
    return new THREE.Vector3(p.x, 0, p.z);
  }

  // ---------------- 主更新 ----------------
  update(dt) {
    if (this.mixer) this.mixer.update(dt);
    this._animSwitchTimer = Math.max(0, this._animSwitchTimer - dt);
    this._knockCooldown = Math.max(0, this._knockCooldown - dt);

    // 重生渐显：从透明过渡到完全可见，避免凭空闪现
    if (this.spawnFade > 0) {
      this.spawnFade -= dt;
      const total = ENEMY.spawnFadeTime || 0.4;
      const k = Math.min(1, 1 - Math.max(0, this.spawnFade) / total);
      for (const m of this.materials) {
        m.transparent = true;
        m.opacity = k;
        m.depthWrite = k >= 1;
      }
      if (this.spawnFade <= 0) {
        for (const m of this.materials) {
          m.transparent = false;
          m.opacity = 1;
          m.depthWrite = true;
        }
      }
    }

    // 受击红闪：快速衰减到基础自发光，连射时不会持续发红（"闪烁"的来源）
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.flashTimer = 0;
        for (const m of this.materials) m.emissive.copy(this.baseEmissive);
      } else {
        const k = this.flashTimer / 0.16;
        const e = k * k;    // 二次衰减：一开始亮，随即可见地暗下去
        for (const m of this.materials) {
          m.emissive.setRGB(
            this.baseEmissive.r + e * 0.85,
            this.baseEmissive.g,
            this.baseEmissive.b
          );
        }
      }
    }

    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 1) {
        const k = Math.max(0, this.deadTimer);
        for (const m of this.materials) {
          m.transparent = true;
          m.opacity = k;
        }
      }
      if (this.deadTimer <= 0) this.root.visible = false;

      // 胖子死亡后遗留毒雾：尸体淡出期间仍对范围内玩家持续造成毒伤
      if (this._poisonCloud) {
        this._poisonEndTime -= dt;
        this._poisonTick += dt;
        if (this._poisonTick >= 1.0) {
          this._poisonTick = 0;
          if (this.player && !this.player.dead) {
            const dx = this.player.position.x - this.position.x;
            const dz = this.player.position.z - this.position.z;
            const d = Math.hypot(dx, dz);
            if (d < this.variant.explodeRadius) {
              const dealt = this.player.takeDamage(this.variant.damage * 0.4 * this.damageMul);
              if (dealt > 0) this.onPlayerHit(dealt);
            }
          }
        }
        if (this._poisonEndTime <= 0) {
          if (this._poisonCloud.parent) this.scene.remove(this._poisonCloud);
          this._poisonCloud = null;
        }
      }
      return;
    }

    // 胖子死亡倒计时（dying）：闪烁预警，超时触发爆炸
    if (this.state === 'dying') {
      this.fuseTimer -= dt;
      const blink = Math.sin(this.fuseTimer * 40) > 0 ? 1 : 0.35;
      for (const m of this.materials) {
        m.emissive.setRGB(blink, blink * 0.18, 0);
      }
      if (this.fuseTimer <= 0) {
        this._explode();
        // 爆炸后进入真正的尸体状态，走尸体淡出流程
        this.dead = true;
        this.state = 'dead';
        this.deadTimer = ENEMY.deathBodyTime;
        this.bar.visible = false;
        this.flashTimer = 0;
        for (const m of this.materials) m.emissive.copy(this.baseEmissive);
        return;
      }
      this._movePhysics(dt);
      return;
    }

    this._updateStatus(dt);

    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.flinchTimer > 0) this.flinchTimer -= dt;

    // 感知：视野 + 听觉
    const sees = this._canSeePlayer();

    // 听觉警觉倒计时：听到枪声后朝声源移动，时间结束则恢复巡逻
    if (this._hearTimer > 0) {
      this._hearTimer -= dt;
      if (this._hearTimer <= 0) {
        this._hearPos = null;
        if (this.state === 'chase' && !sees) {
          this.state = 'alert';
          this.alertTimer = ENEMY.alertTime;
          this.baseScanHeading = this.heading;
          this.scanTime = 0;
        }
      }
    }

    const distToPlayer = this.player
      ? Math.hypot(this.player.position.x - this.position.x, this.player.position.z - this.position.z)
      : Infinity;

    // 追击延迟已移除：丧尸发现玩家立即追击，不再愣在原地
    if (this.roarCooldown > 0) this.roarCooldown -= dt;

    // howler 嘶吼：发现玩家时触发一次范围内敌人警觉
    if (this.variant.howler && sees && this.roarCooldown <= 0) {
      this.onRoar(this);
      this.roarCooldown = 8.0;
    }

    // 近距离全方位感知（防止背后被发现也没反应）
    const seesClose = this._canSeePlayerWide();

    // 状态切换：发现玩家立即进入追击/攻击，不再先 alert 停顿
    if (sees || seesClose) {
      this.lastKnown.copy(this.player.position);
      this.alertTimer = ENEMY.alertTime;
      this.loseSightTimer = 0;
      this.state = distToPlayer <= this.variant.attackRange ? 'attack' : 'chase';
    } else if (this.state === 'attack' || this.state === 'chase' || this.state === 'alert') {
      if (this.state !== 'alert') {
        this.state = 'alert';
        this.alertTimer = ENEMY.alertTime;
        this.baseScanHeading = this.heading;
        this.scanTime = 0;
      }
      this.alertTimer -= dt;
      if (this.alertTimer <= 0) {
        this.state = 'patrol';
        this.targetPoint = this._pickPatrolPoint();
      }
    } else {
      this.state = 'patrol';
      this.loseSightTimer = 0;
    }

    if (this.state === 'patrol') this._updatePatrol(dt);
    else if (this.state === 'alert') this._updateAlert(dt);
    else if (this.state === 'chase') {
      if (this._updateChase(dt, distToPlayer)) return;   // 奔跑者冲刺已自行处理物理
    }
    else if (this.state === 'attack') this._updateAttack(dt, distToPlayer);

    // 平滑转头，受击时附加抖动
    const turnDelta = shortestAngle(this.targetHeading - this.heading);
    this.heading += turnDelta * Math.min(1, ENEMY.turnSpeed * dt);

    // 物理移动
    this.velocity.y += -16 * dt;
    this.collision.moveCharacter(this.position, this.velocity, dt, ENEMY.radius, ENEMY.height);

    this.root.position.copy(this.position);
    const flinchK = this.flinchTimer > 0 ? this.flinchTimer / ENEMY.flinchTime : 0;
    this.root.rotation.y = this.heading + Math.sin(this.flinchTimer * 18) * 0.12 * flinchK;
    this.bar.position.set(0, ENEMY.height + 0.3, 0);
    this._checkStuck(dt);
  }

  _updatePatrol(dt) {
    const target = this.targetPoint;
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.2) {
      this.targetPoint = this._pickPatrolPoint();
      return;
    }
    this._moveToward(dx, dz, this.variant.patrolSpeed, dt);
    this._play('walk');
  }

  _updateAlert(dt) {
    const dx = this.lastKnown.x - this.position.x;
    const dz = this.lastKnown.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    this.scanTime += dt;
    if (dist > 1.6) {
      this._moveToward(dx, dz, this.variant.chaseSpeed * 0.7, dt);
      this._play('walk');
    } else {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
      this.targetHeading = this.baseScanHeading + Math.sin(this.scanTime * 2.2) * 0.9;
      this._play('walk');
    }
  }

  _updateChase(dt, dist) {
    if (!this.player) return;
    const v = this.variant;

    // 奔跑者：冷却结束时向玩家方向发起直线冲刺，冲刺期间锁定方向不转弯
    if (v.runner) {
      if (this.dashCooldown > 0) this.dashCooldown -= dt;
      if (this.dashTimer > 0) {
        // 冲刺中：沿锁定方向直线加速，不受避障与转向影响
        this.dashTimer -= dt;
        this.velocity.x = this._dashDir.x * v.chaseSpeed * 1.9;
        this.velocity.z = this._dashDir.z * v.chaseSpeed * 1.9;
        this._play('run');
        this.targetHeading = Math.atan2(this._dashDir.x, this._dashDir.z);
        this._movePhysics(dt);
        return true;
      }
      if (dist > v.attackRange && this.dashCooldown <= 0) {
        this.dashTimer = 0.45;                 // 冲刺持续 0.45s
        this.dashCooldown = 2.6;               // 冲刺冷却 2.6s
        this._dashDir.set(
          Math.sin(this.heading) || (this.player.position.x - this.position.x),
          0,
          Math.cos(this.heading) || (this.player.position.z - this.position.z)
        );
        const len = Math.hypot(this._dashDir.x, this._dashDir.z);
        if (len > 0) {
          this._dashDir.x /= len;
          this._dashDir.z /= len;
        }
        this._play('run');
        return;
      }
    }

    // 听到枪声但未见玩家：朝声源移动；看到玩家后再朝玩家逼近
    let dx = this.player.position.x - this.position.x;
    let dz = this.player.position.z - this.position.z;
    let targetDist = dist;
    if (this._hearPos && !this._canSeePlayer() && !this._canSeePlayerWide()) {
      const hx = this._hearPos.x - this.position.x;
      const hz = this._hearPos.z - this.position.z;
      dx = hx;
      dz = hz;
      targetDist = Math.hypot(hx, hz);
    }
    // 丧尸永远朝玩家逼近（近战）；吐酸丧尸逼近到舒适距离即停
    const keep = this.melee ? this.variant.keepDistance : this.variant.keepDistance;
    if (targetDist > keep) {
      this._moveToward(dx, dz, this.variant.chaseSpeed, dt);
    } else {
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
      this.targetHeading = Math.atan2(dx, dz);
    }
    this._play('run');
  }

  _updateAttack(dt, dist) {
    if (!this.player) return;
    const dx = this.player.position.x - this.position.x;
    const dz = this.player.position.z - this.position.z;
    const v = this.variant;

    // 近战丧尸：贴近玩家后挥击
    if (this.melee) {
      this.targetHeading = Math.atan2(dx, dz);

      // 前摇期间：锁移动 + 播放 attack 动画，前摇结束才结算伤害。
      // 注意：不能用 currentAnim === 'attack' 当作状态门控 —— 攻击动画是
      // LoopOnce，播完后 currentAnim 会一直停在 attack，丧尸会永久卡死原地，
      // 玩家一走远又突然全速追上来，观感上就是"影子飞速扑过来"。
      if (this.windupTimer > 0) {
        this.windupTimer -= dt;
        // 不是瞬间归零，而是快速衰减，避免急刹般的瞬停
        const brake = Math.max(0, 1 - dt * 14);
        this.velocity.x *= brake;
        this.velocity.z *= brake;
        if (this.windupTimer <= 0 && !this.windupDone) {
          this.windupDone = true;
          this._meleeStrike(dist);
          // 挥击落地后立刻回到 run，让丧尸重新参与追击，不再定格
          this.currentAnim = null;
          this._play('run', false, true);
        }
        return;
      }

      // 非前摇期：贴近 / 绕侧移
      if (dist > v.attackRange * 0.6) {
        this._moveToward(dx, dz, v.chaseSpeed, dt);
      } else {
        this.velocity.x *= 0.7;
        this.velocity.z *= 0.7;
        // 绕着玩家缓慢侧移，避免完全站桩
        this.coverTimer -= dt;
        if (this.coverTimer <= 0) {
          this.coverTimer = 1.8 + Math.random() * 1.4;
          this.coverSign = Math.random() < 0.5 ? -1 : 1;
        }
        const px = -dz * this.coverSign * 0.35;
        const pz = dx * this.coverSign * 0.35;
        this._moveToward(px, pz, v.patrolSpeed * 0.6, dt);
      }

      // 冷却到点且在触及范围内 → 开始前摇 + 播放 attack 动画
      if (this.attackTimer <= 0 && dist <= v.attackRange) {
        this.windupTimer = v.windup || 0.35;
        this.windupDone = false;
        this.attackTimer = v.attackInterval;
        this.onMelee(this);
        this.currentAnim = null;          // 允许 attack 动画重新播放
        this._play('attack', true, true);
      } else {
        this._play('run');
      }
      return;
    }

    // 自爆丧尸：靠近后引爆，范围伤害
    if (this.variant.bomber) {
      // 贴近时停下，开始倒计时
      if (dist > v.attackRange * 0.9) {
        this._moveToward(dx, dz, v.chaseSpeed, dt);
        this._play('run');
      } else {
        this.velocity.x *= 0.6;
        this.velocity.z *= 0.6;
        if (!this.fuseStarted) {
          this.fuseStarted = true;
          this.fuseTimer = v.fuseTime;
          this.onMelee(this); // 复用"开始攻击"回调（触发音效等）
        }
        // 闪烁橙光警告（用自身材质，之前引用了不存在的 flashMat 导致没有效果）
        const blink = Math.sin(this.fuseTimer * 40) > 0 ? 1 : 0.35;
        for (const m of this.materials) {
          m.emissive.setRGB(blink, blink * 0.18, 0);
        }
        this.fuseTimer -= dt;
        if (this.fuseTimer <= 0) {
          this._explode();
          return;
        }
      }
      this.targetHeading = Math.atan2(dx, dz);
      return;
    }

    // 吐酸丧尸：保持距离 + 定期喷吐
    if (dist < v.keepDistance * 0.8) {
      this._moveToward(-dx, -dz, v.chaseSpeed * 0.85, dt);
    } else if (dist > v.attackRange * 0.9) {
      this._moveToward(dx, dz, v.chaseSpeed, dt);
    } else {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
    }
    this.targetHeading = Math.atan2(dx, dz);

    if (this.attackTimer <= 0 && dist <= v.attackRange) {
      this.attackTimer = v.attackInterval * (0.85 + Math.random() * 0.4);
      this._spit(dist);
      this.currentAnim = null;
      this._play('attack', true);
    } else {
      this._play('run');
    }
  }

  /** 近战判定：前摇结束时玩家仍在触及范围（允许一点容错）则造成伤害 */
  _meleeStrike(dist) {
    if (!this.player || this.player.dead) return;
    // 收紧判定范围，避免"隔空打飞"的观感
    const reach = this.variant.attackRange * 1.08;
    if (dist > reach) return;   // 玩家已逃出挥击范围
    const dealt = this.player.takeDamage(this.variant.damage * this.damageMul);
    if (dealt > 0) this.onPlayerHit(dealt);
    // boss 重击：额外把 hitSlow 拉到 0.9s（双倍僵直）
    if (this.variant.boss && this.player.hitSlowTimer < 0.9) {
      this.player.hitSlowTimer = 0.9;
    }
  }

  /** 自爆：对范围内玩家造成伤害，自身死亡，触发爆炸特效 */
  _explode() {
    const v = this.variant;
    const radius = v.explodeRadius;
    // 玩家受伤（距离越近伤害越高）
    if (this.player && !this.player.dead) {
      const dx = this.player.position.x - this.position.x;
      const dz = this.player.position.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d < radius) {
        const falloff = 1 - (d / radius) * 0.5; // 中心 100%，边缘 50%
        const dmg = v.damage * this.damageMul * falloff;
        const dealt = this.player.takeDamage(dmg);
        if (dealt > 0) this.onPlayerHit(dealt);
      }
    }
    // 胖子死亡爆炸：遗留毒雾范围，持续秒数由 poisonTime 决定
    if (v.fat) {
      this._poisonCloud = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.6, 16, 16),
        new THREE.MeshBasicMaterial({
          color: 0x22aa22,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
        })
      );
      this._poisonCloud.position.copy(this.position);
      this._poisonCloud.position.y = 0.6;
      this.scene.add(this._poisonCloud);
      this._poisonEndTime = v.poisonTime || 5.0;
      this._poisonTick = 0;
    }
    // 爆炸特效 + 音效（通过回调交给 Game 层处理）
    if (this.onExplode) this.onExplode(this);
    // 自身死亡（不触发 onKill 回调，因为是自爆不是被击杀）
    this.dead = true;
  }

  /**
   * 吐酸（非枪械）：酸液抛物线视觉 + 命中率随距离衰减。
   * 与枪械完全分离：不消耗弹药、不产生弹壳、不走 GunSystem 通道。
   */
  _spit(dist) {
    if (!this.player || this.player.dead) return;
    const origin = this.position.clone();
    origin.y += 1.5;
    const target = this.player.camera.position.clone();

    const v = this.variant;
    const t = Math.min(1, dist / (v.accuracyRange || 30));
    const chance = Math.min(0.9,
      Math.max(v.accuracyMin, v.accuracy * (1 - t)) * this.accuracyMul);

    const hit = Math.random() < chance;
    const end = target.clone();
    if (!hit) {
      const missScale = 0.8 + t * 1.8;
      end.x += (Math.random() - 0.5) * missScale;
      end.y += (Math.random() - 0.5) * missScale * 0.7;
      end.z += (Math.random() - 0.5) * missScale;
    }

    this.onSpit(origin, end, this);
    if (hit) {
      const dealt = this.player.takeDamage(v.damage * this.damageMul);
      if (dealt > 0) this.onPlayerHit(dealt);
    }
  }

  /** 朝目标方向移动（含简单绕障） */
  _moveToward(dx, dz, speed, dt) {
    speed *= this.speedMul * this.statusSpeedMul;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return;
    let dirX = dx / len;
    let dirZ = dz / len;

    if (this.avoidTimer > 0) {
      this.avoidTimer -= dt;
      const px = -dirZ * this.avoidSign;
      const pz = dirX * this.avoidSign;
      dirX = px;
      dirZ = pz;
    }

    const desiredX = dirX * speed;
    const desiredZ = dirZ * speed;
    const k = Math.min(1, dt * 6);
    this.velocity.x += (desiredX - this.velocity.x) * k;
    this.velocity.z += (desiredZ - this.velocity.z) * k;

    // 速度上限钳制：防止击退叠加追击导致的"飞扑"瞬移观感
    const maxSpeed = speed * 1.5;
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp > maxSpeed) {
      this.velocity.x = (this.velocity.x / sp) * maxSpeed;
      this.velocity.z = (this.velocity.z / sp) * maxSpeed;
    }
    // 朝向用「期望方向」而不是速度向量：速度接近 0 时速度向量的角度会剧烈跳动，
    // 模型就会左右抖动（用户看到的"闪烁"）
    this.targetHeading = Math.atan2(dirX, dirZ);
  }

  /** 执行物理移动（奔跑者冲刺时绕过 _moveToward 的减速与避障） */
  _movePhysics(dt) {
    this.velocity.y += -16 * dt;
    this.collision.moveCharacter(this.position, this.velocity, dt, ENEMY.radius, ENEMY.height);
    this.root.position.copy(this.position);
    const flinchK = this.flinchTimer > 0 ? this.flinchTimer / ENEMY.flinchTime : 0;
    this.root.rotation.y = this.heading + Math.sin(this.flinchTimer * 18) * 0.12 * flinchK;
    this.bar.position.set(0, ENEMY.height + 0.3, 0);
    this._checkStuck(dt);
  }

  _checkStuck(dt) {
    const moved = this.position.distanceTo(this.lastPos);
    if (this.state !== 'dead' && moved < 0.01) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5) {
        this.avoidTimer = 0.9;
        this.avoidSign = Math.random() < 0.5 ? -1 : 1;
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }
    this.lastPos.copy(this.position);
  }

  // ---------------- 元素状态 ----------------
  /**
   * 施加元素状态（由枪口配件 / 弹种触发）
   * @param {'burn'|'poison'|'slow'} type
   * @param {number} duration 持续秒数
   * @param {number} value 灼烧/毒伤 DPS，或减速系数（slow）
   */
  applyStatus(type, duration, value) {
    if (this.dead) return;
    if (type === 'burn') {
      this.burnTimer = Math.max(this.burnTimer, duration);
      this.burnDps = Math.max(this.burnDps, value);
    } else if (type === 'poison') {
      this.poisonTimer = Math.max(this.poisonTimer, duration);
      this.poisonDps = Math.max(this.poisonDps, value);
    } else if (type === 'slow') {
      this.slowTimer = Math.max(this.slowTimer, duration);
      this.statusSpeedMul = Math.min(this.statusSpeedMul, value);
    }
  }

  /** 风元素击退 */
  addKnockback(dirX, dirZ, force) {
    if (this.dead) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    this.velocity.x += (dirX / len) * force;
    this.velocity.z += (dirZ / len) * force;
  }

  /** 每帧结算持续伤害与减速回正 */
  _updateStatus(dt) {
    if (this.burnTimer > 0) {
      this.burnTimer -= dt;
      this._applyDot(this.burnDps * dt);
      if (this.burnTimer <= 0) this.burnDps = 0;
      if (this.dead) return;
    }
    if (this.poisonTimer > 0) {
      this.poisonTimer -= dt;
      this._applyDot(this.poisonDps * dt);
      if (this.poisonTimer <= 0) this.poisonDps = 0;
      if (this.dead) return;
    }
    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      if (this.slowTimer <= 0) this.statusSpeedMul = 1;
    }
  }

  _applyDot(amount) {
    if (this.dead || amount <= 0) return;
    this.health -= amount;
    this._updateBar();
    if (this.health <= 0) {
      this.health = 0;
      this._die();
    }
  }

  // ---------------- 伤害 ----------------
  takeDamage(amount) {
    if (this.dead) return false;
    // 胖子已进入 delayed 起爆倒计时：不再吃伤害，避免重复走 _die() 打断爆炸
    if (this.state === 'dying') return false;
    this.health -= amount;
    // 红闪只在原本没在闪的时候点亮，连射（尤其霰弹 8 颗弹丸）不会一直发红
    if (this.flashTimer <= 0) this.flashTimer = 0.16;
    this.flinchTimer = ENEMY.flinchTime;
    if (this.player && !this.player.dead && this._knockCooldown <= 0) {
      // 击退限频：每颗弹丸都推一把会叠加成瞬移，观感像影子飞扑
      const dx = this.position.x - this.player.position.x;
      const dz = this.position.z - this.player.position.z;
      const len = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / len) * 1.2;
      this.velocity.z += (dz / len) * 1.2;
      this.avoidTimer = 0.5;
      this.avoidSign = Math.random() < 0.5 ? -1 : 1;
      this._knockCooldown = 0.10;
      this.lastKnown.copy(this.player.position);
    }
    this._updateBar();

    if (this.state === 'patrol' || this.state === 'alert') {
      if (this.player && !this.player.dead) {
        this.state = 'chase';
        this.alertTimer = ENEMY.alertTime;
      }
      this.loseSightTimer = 0;
    }

    if (this.health <= 0) {
      this.health = 0;
      this._die();
      return true;
    }
    return false;
  }

  _die() {
    // 胖子：死亡后延时爆炸+毒雾，不立即进入 dead 状态，先进入 dying 倒计时
    if (this.variant.fat && !this.fuseStarted) {
      this.fuseStarted = true;
      this.fuseTimer = this.variant.fuseTime;
      this.state = 'dying';
      this.velocity.set(0, 0, 0);
      this.bar.visible = false;
      this.windupTimer = 0;
      this.windupDone = false;
      this.flashTimer = 0;
      for (const m of this.materials) m.emissive.copy(this.baseEmissive);
      this._play('death', true, true, true);
      this.onDeath(this);  // 死亡时已算作击杀（掉落/金币等）
      return;
    }
    this.dead = true;
    this.state = 'dead';
    this.deadTimer = ENEMY.deathBodyTime;
    this.velocity.set(0, 0, 0);
    this.bar.visible = false;
    this.windupTimer = 0;
    this.windupDone = false;
    this.fuseStarted = false;
    // 清掉红闪 / 自爆预警的残留发光，否则尸体会一直亮着
    this.flashTimer = 0;
    for (const m of this.materials) m.emissive.copy(this.baseEmissive);
    this._play('death', true, true, true);
    this.onDeath(this);
  }

  /** 重新投放 */
  respawn(spawn) {
    this.spawn.copy(spawn);
    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.dead = false;
    this.deadTimer = 0;
    this.state = 'patrol';
    this.root.visible = true;
    this.attackTimer = 0;
    this.windupTimer = 0;
    this.windupDone = false;
    this.stuckTimer = 0;
    this.loseSightTimer = 0;
    this.flinchTimer = 0;
    this.burnTimer = 0;
    this.burnDps = 0;
    this.poisonTimer = 0;
    this.poisonDps = 0;
    this.slowTimer = 0;
    this.statusSpeedMul = 1;
    this.coverTimer = 1.0;
    this.coverStrafe = 0;
    this.alertTimer = 0;
    this.scanTime = 0;
    this.fuseStarted = false;
    this.fuseTimer = 0;
    this._poisonCloud = null;
    this._poisonEndTime = 0;
    this._poisonTick = 0;
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;
    this.targetPoint = this._pickPatrolPoint();
    this.lastPos.copy(this.position);
    this.chaseLinger = 0;
    this._animSwitchTimer = 0;
    this.roarCooldown = 0;
    this._knockCooldown = 0;
    this.flashTimer = 0;
    // 重生淡出：从透明渐显，避免凭空"闪现"在视野内
    this.spawnFade = ENEMY.spawnFadeTime || 0.4;
    for (const m of this.materials) {
      m.opacity = 0;
      m.transparent = true;
      m.depthWrite = false;
      m.visible = true;
      m.emissive.copy(this.baseEmissive);
    }
    this.bar.visible = false;
    this._updateBar();
    this.currentAnim = null;
    this._play('idle', false, true);
  }

  /** 射线与丧尸命中球求交（用于玩家射击）；返回 part: head / body / limb */
  raycast(origin, dir, maxDist) {
    if (this.dead || !this.root.visible) return null;

    const bodyCenter = this.position.clone();
    bodyCenter.y += ENEMY.bodyHeight;
    const headCenter = this.position.clone();
    headCenter.y += ENEMY.headHeight;
    const limbCenter = this.position.clone();
    limbCenter.y += 0.30;

    let best = null;
    const consider = (t, part) => {
      if (t !== null && t <= maxDist && (!best || t < best.t)) best = { t, part };
    };
    consider(raySphere(origin, dir, headCenter, SPHERE.head), 'head');
    consider(raySphere(origin, dir, bodyCenter, SPHERE.body), 'body');
    consider(raySphere(origin, dir, limbCenter, SPHERE.limb), 'limb');
    if (!best) return null;

    return {
      enemy: this,
      distance: best.t,
      part: best.part,
      head: best.part === 'head',
      point: origin.clone().addScaledVector(dir, best.t),
    };
  }
}

/** 角度差归一化到 [-π, π] */
function shortestAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 射线与球求交，返回最近的正向距离 */
function raySphere(origin, dir, center, radius) {
  const oc = center.clone().sub(origin);
  const t = oc.dot(dir);
  if (t < 0) return null;
  const d2 = oc.lengthSq() - t * t;
  if (d2 > radius * radius) return null;
  const thc = Math.sqrt(radius * radius - d2);
  const t0 = t - thc;
  const t1 = t + thc;
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}
