/**
 * 玩家控制器（对应仓库 MovementScript.cs）
 * WASD 移动 / Shift 疾跑 / C 蹲下 / 空格跳跃 / 重力 / 碰撞 / 头部晃动 / 脚步声
 */
import * as THREE from 'three';
import { PLAYER } from '../config/weapon.js';
import { PlayerHealth } from './PlayerHealth.js';

export class PlayerController {
  constructor(camera, input, collision, audio, spawn) {
    this.camera = camera;
    this.input = input;
    this.collision = collision;
    this.audio = audio;

    this.position = spawn.clone();       // 脚底中心
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    this.health = new PlayerHealth();
    this.dead = false;

    this.bobTime = 0;
    this.bobAmount = 0;
    this.footstepVolume = 0;
    this.landShake = 0;     // 落地震屏强度
    this._wasAirborne = false;
    this._peakFallSpeed = 0;
    // 翻越（vault）状态：翻越期间锁定控制并播放动画
    this.vaulting = false;
    this.vaultTimer = 0;
    this.vaultDir = new THREE.Vector3();
    // 蹲伏 / 受击僵直 / 疾跑
    this.isCrouching = false;
    this.isSlow = false;
    this.isSprinting = false;
    this.hitSlowTimer = 0;
    // 受击僵直减免（Roguelike perk 写入，1 = 完全不受僵直影响）
    this.hitSlowResist = 0;
    this.eyeHeight = PLAYER.eyeHeight;
    this.currentHeight = PLAYER.height;
    // 局外成长 / 机甲形态的速度倍率；护盾值（机甲形态吸收伤害）
    this.speedMul = 1;
    this.shield = 0;
    this.shieldMax = 0;
    this.footstep = audio ? audio.createLoop('walkLoop', 0) : null;
    this.runStep = audio ? audio.createLoop('runLoop', 0) : null;
  }

  /** 每帧更新 */
  update(dt, mouseLook) {
    if (this.dead) {
      this.velocity.set(0, 0, 0);
      this._syncCamera(mouseLook, 0);
      mouseLook.update(dt);
      if (this.footstep) this.footstep.setVolume(0);
      return;
    }

    const input = this.input;
    const forward = mouseLook.getForward();
    const right = { x: Math.cos(mouseLook.yaw), z: -Math.sin(mouseLook.yaw) };

    // 输入方向（动作映射：默认 W 前 / S 后 / A 左 / D 右，可在设置界面改键）
    let ix = (input.actionDown('right') ? 1 : 0) - (input.actionDown('left') ? 1 : 0);
    let iz = (input.actionDown('forward') ? 1 : 0) - (input.actionDown('backward') ? 1 : 0);

    let dx = right.x * ix + forward.x * iz;
    let dz = right.z * ix + forward.z * iz;
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }

    // 疾跑（长按 Shift）/ 静步（长按 Alt）/ 蹲下（长按 C）
    const sprint = input.actionDown('sprint');
    const slow = input.actionDown('walk');
    let wantCrouch = input.actionDown('crouch');
    // 第三轮：起身前检测头顶空间，避免站起时卡进矮掩体
    if (!wantCrouch && this.isCrouching &&
        !this.collision.canFit(this.position, PLAYER.radius, PLAYER.height)) {
      wantCrouch = true; // 头顶被挡住，保持蹲伏
    }
    this.isCrouching = wantCrouch;
    this.isSlow = slow && !wantCrouch;
    // 疾跑：必须按住方向键、非蹲伏、非静步
    this.isSprinting = sprint && !wantCrouch && !slow && (ix !== 0 || iz !== 0);

    // 受击僵直：短时间内移动速度降低
    let speed = wantCrouch ? PLAYER.crouchSpeed
             : (this.isSprinting ? PLAYER.sprintSpeed
             : (slow ? PLAYER.slowSpeed : PLAYER.walkSpeed));
    if (this.hitSlowTimer > 0) {
      this.hitSlowTimer -= dt;
      const resist = Math.max(0, Math.min(1, this.hitSlowResist || 0));
      speed *= PLAYER.hitSlowFactor + (1 - PLAYER.hitSlowFactor) * resist;
    }
    speed *= this.speedMul;

    // 蹲伏时平滑过渡眼睛高度与碰撞体高度
    const targetEye = wantCrouch ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    const targetHeight = wantCrouch ? PLAYER.crouchHeight : PLAYER.height;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 10);
    this.currentHeight += (targetHeight - this.currentHeight) * Math.min(1, dt * 10);

    // 水平速度：加速度趋近目标速度（空中操控力降低）
    const accel = this.grounded ? PLAYER.accel : PLAYER.airAccel;
    const targetX = dx * speed;
    const targetZ = dz * speed;
    const k = Math.min(1, accel * dt);
    this.velocity.x += (targetX - this.velocity.x) * k;
    this.velocity.z += (targetZ - this.velocity.z) * k;

    // 跳跃 + 自动翻越（前方矮箱 / 矮墙 / 集装箱顶可直接跳上去）
    if (this.grounded && input.consumeAction('jump')) {
      const vaultTop = this.collision.findVaultTop(
        this.position, dx, dz, PLAYER.radius, this.currentHeight, PLAYER.vaultHeight
      );
      if (vaultTop != null) {
        // 翻越：进入 vault 状态，向前方冲一个短冲量，再抬上顶面，手感比纯传送更自然
        this.vaulting = true;
        this.vaultTimer = PLAYER.vaultTime;
        this.vaultDir.set(dx, 0, dz);
        this.position.y = vaultTop + 0.001;
        this.velocity.y = PLAYER.vaultLift;
        this.velocity.x += this.vaultDir.x * PLAYER.vaultPush;
        this.velocity.z += this.vaultDir.z * PLAYER.vaultPush;
      } else {
        this.velocity.y = PLAYER.jumpSpeed;
      }
      this.grounded = false;
    }

    // 翻越期间锁定控制，逐步衰减水平冲量并恢复普通空中状态
    if (this.vaulting) {
      this.vaultTimer -= dt;
      this.velocity.x *= Math.max(0, 1 - dt * 6);
      this.velocity.z *= Math.max(0, 1 - dt * 6);
      if (this.vaultTimer <= 0) this.vaulting = false;
    }

    // 重力
    this.velocity.y += PLAYER.gravity * dt;
    if (this.velocity.y < -22) this.velocity.y = -22;

    // 碰撞移动（使用当前动态高度，蹲伏时降低碰撞盒）
    const res = this.collision.moveCharacter(
      this.position, this.velocity, dt, PLAYER.radius, this.currentHeight
    );

    // 落地检测与震屏
    if (!this.grounded) {
      this._wasAirborne = true;
      this._peakFallSpeed = Math.max(this._peakFallSpeed, -this.velocity.y);
    } else if (this._wasAirborne) {
      // 刚落地：按下落峰值速度触发相机震动 + 落地音效
      this.landShake = Math.min(0.05, this._peakFallSpeed * 0.007);
      if (this._peakFallSpeed > 2.2) {
        this.audio.play('land', {
          volume: Math.min(0.75, this._peakFallSpeed * 0.05),
          rate: 0.95 + Math.random() * 0.1,
        });
      }
      this._wasAirborne = false;
      this._peakFallSpeed = 0;
    }
    this.grounded = res.grounded;
    this.landShake = Math.max(0, this.landShake - dt * 0.5);

    // 头部晃动 & 脚步声
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = this.grounded && horizontalSpeed > 0.6;
    if (moving) {
      this.bobTime += dt * (wantCrouch ? 5.5 : (slow ? 7.2 : 10.5));
      this.bobAmount += (1 - this.bobAmount) * Math.min(1, dt * 8);
    } else {
      this.bobAmount += (0 - this.bobAmount) * Math.min(1, dt * 8);
    }

    this._syncCamera(mouseLook, this.bobAmount);
    mouseLook.update(dt);

    // 脚步声：静步低音量慢速，正常跑步音量更大更快，蹲伏几乎无声
    const walkTarget = moving ? (wantCrouch ? 0.02 : (slow ? 0.05 : 0.20)) : 0;
    const runTarget = (moving && !slow && !wantCrouch) ? 0.26 : 0;
    this.footstepVolume += (walkTarget - this.footstepVolume) * Math.min(1, dt * 10);
    if (this.footstep) {
      this.footstep.setVolume(this.footstepVolume);
      this.footstep.setRate(slow ? 0.9 : 1.1);
    }
    if (this.runStep) {
      this.runStep.setVolume(moving && !slow && !wantCrouch ? this.footstepVolume * 1.3 : 0);
      this.runStep.setRate(1.25);
    }
  }

  /** 同步相机位置（含走路上下起伏 + 落地震动） */
  _syncCamera(mouseLook, bobAmount) {
    const bobY = Math.sin(this.bobTime * 2) * 0.028 * bobAmount;
    const bobRoll = Math.cos(this.bobTime) * 0.004 * bobAmount;
    // 落地震动：快速衰减的随机偏移
    const shake = this.landShake > 0 ? this.landShake * (Math.random() - 0.5) * 2 : 0;
    const shakeY = this.landShake > 0 ? this.landShake * Math.random() : 0;
    this.camera.position.set(
      this.position.x + shake,
      this.position.y + this.eyeHeight + bobY - shakeY * 0.6,
      this.position.z + shake * 0.5
    );
    mouseLook.bobPitch = bobRoll;
  }

  /** 承伤；返回本次伤害值，并触发受击僵直 */
  takeDamage(amount) {
    if (this.dead) return 0;
    // 机甲护盾优先吸收
    let dmg = amount;
    if (this.shield > 0 && dmg > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
      if (this.shield <= 0) this.shield = 0;
    }
    if (dmg <= 0) return 0;
    const real = this.health.damage(dmg);
    if (this.health.dead) this.dead = true;
    this.applyHitSlow();
    return real;
  }

  /** 受击减速：短暂降低移动速度，模拟僵直 */
  applyHitSlow() {
    this.hitSlowTimer = PLAYER.hitSlowTime;
  }

  /** 复活 */
  respawn(spawn) {
    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.health.reset();
    this.dead = false;
    this.bobAmount = 0;
    this.bobTime = 0;
    this.isCrouching = false;
    this.isSlow = false;
    this.isSprinting = false;
    this.hitSlowTimer = 0;
    this.eyeHeight = PLAYER.eyeHeight;
    this.currentHeight = PLAYER.height;
  }

  /** 眼睛（相机）世界坐标 */
  getEyePosition() {
    return this.camera.position.clone();
  }
}
