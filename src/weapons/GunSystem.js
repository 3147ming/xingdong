/**
 * 枪械系统（v0.4 多武器版）
 * 支持 rifle / pistol / shotgun 三把武器，按 1/2/3 切换。
 * 每把武器独立弹匣、备弹、热度；霰弹枪一次发射多颗弹丸。
 */
import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER, WEAPON_UNLOCKED } from '../config/weapon.js';
import { AMMO_TYPES, ELEMENTS, deriveWeapon } from '../config/mods.js';
import { AMMO_SHOP } from '../config/progression.js';

const UP = new THREE.Vector3(0, 1, 0);

export class GunSystem {
  constructor(deps) {
    this.camera = deps.camera;
    this.player = deps.player;
    this.mouseLook = deps.mouseLook;
    this.view = deps.weaponView;
    this.effects = deps.effects;
    this.casings = deps.casings;
    this.audio = deps.audio;
    this.collision = deps.collision;
    this.enemies = deps.enemies;
    this.hud = deps.hud;
    this.onKill = deps.onKill || (() => {});
    this.onShot = deps.onShot || (() => {});

    // 改装合成后的实际武器数据（默认全部"无改装"）
    this.loadout = {};
    this.weapons = {};
    for (const id of WEAPON_UNLOCKED) {
      this.weapons[id] = deriveWeapon(WEAPONS[id], {});
    }

    // 每把武器的独立运行时状态
    this._states = {};
    for (const id of WEAPON_UNLOCKED) {
      const w = this.weapons[id];
      this._states[id] = {
        mag: w.magazineSize,
        reserve: w.reserveAmmo,
        heat: 0,
        burstCount: 0,
      };
    }
    this.currentId = WEAPON_UNLOCKED[0];

    this.cooldown = 0;
    this.inputMouseDown = false;
    this.inputFirePressed = false;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.spread = this._current.spreadBase;
    this.shotCount = 0;
    this.recoilYawDir = 0;
    this.reloadInsertPlayed = false;
    this.reloadDuration = this._current.reloadTime;
    this.switchCooldown = 0; // 切枪冷却，防止滚轮连切

    // 局外成长 / 机甲形态的全局倍率（由 Game 与 MechSystem 写入）
    this.damageMul = 1;
    this.reloadMul = 1;
    this.fireRateMul = 1;
    // 科研加成：暴击与弱点
    this.critChance = 0;
    this.critMul = 1.5;
    this.headshotMulBonus = 1;
    this.bossMul = 1;

    // 开镜
    this.baseFov = this.camera.fov;
    this.aiming = false;
    this.aimProgress = 0;

    // 弹种轮盘
    this.ammoIndex = 0;
    this.ammoWheelOpen = false;
    this._wheelAccum = 0;
    this.comboHits = 0;

    this._tmpDir = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._upVec = new THREE.Vector3(0, 1, 0);

    // 通知视图当前武器
    this.view.setWeapon(this._current);
    this._syncHud();
  }

  /** 应用大厅改装配置（每局开始时调用） */
  applyLoadout(loadout = {}) {
    this.loadout = loadout || {};
    for (const id of WEAPON_UNLOCKED) {
      this.weapons[id] = deriveWeapon(WEAPONS[id], this.loadout[id] || {});
    }
    const st = this._state;
    const W = this._current;
    st.mag = Math.min(st.mag, W.magazineSize);
    this.spread = W.spreadBase;
    this.view.setWeapon(W);
    this._syncHud();
  }

  /** 当前武器配置 */
  get _current() { return this.weapons[this.currentId]; }
  get _state() { return this._states[this.currentId]; }

  /** 当前弹种 */
  get ammoType() { return AMMO_TYPES[this.ammoIndex]; }

  // 向后兼容：探针 / 旧代码直接读 gun.mag / gun.reserve
  get mag() { return this._state.mag; }
  set mag(v) { this._state.mag = v; }
  get reserve() { return this._state.reserve; }
  set reserve(v) { this._state.reserve = v; }

  get reloadProgress() {
    return this.reloading ? Math.min(1, this.reloadElapsed / this.reloadDuration) : 0;
  }

  /**
   * 每帧更新
   * @param {number} dt
   * @param {{x:number,y:number}} mouseDelta
   * @param {boolean} canAct
   */
  update(dt, mouseDelta, canAct) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.switchCooldown > 0) this.switchCooldown -= dt;

    const W = this._current;
    const st = this._state;

    // 开镜过渡：FOV、灵敏度、准星同步变化
    const aimTarget = this.aiming ? 1 : 0;
    this.aimProgress += (aimTarget - this.aimProgress) * Math.min(1, dt * 12);
    const aimK = this.aimProgress;
    const targetFov = this.baseFov + (W.adsFov - this.baseFov) * aimK;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
    if (this.mouseLook) this.mouseLook.aimScale = 1 - aimK * (1 - W.adsSensMul);
    this.hud.setAiming(aimK > 0.5);
    this.hud.setScope(this.currentId === 'sniper' && aimK > 0.55);

    // 连射热度自然衰减
    st.heat = Math.max(0, st.heat - dt * 5.5);
    if (!this.inputMouseDown && !this.inputFirePressed) {
      st.burstCount = Math.max(0, st.burstCount - dt * 7);
      if (st.burstCount <= 0) this.mouseLook.recoilRecover = W.recoilRecover * 1.8;
    } else {
      this.mouseLook.recoilRecover = W.recoilRecover;
    }

    // 散布
    let targetSpread = W.spreadBase + st.heat * W.spreadPerShot;
    if (this.player) {
      const hspeed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
      const stable = this.player.isSlow || this.player.isCrouching;
      targetSpread += Math.min(W.spreadMove, hspeed * 0.006) * (stable ? 0.45 : 1);
      if (!this.player.grounded) targetSpread += 0.02;
      if (this.player.isCrouching) targetSpread *= 0.72;
      if (this.player.isSprinting) targetSpread *= 1.35;
    }
    targetSpread *= 1 - aimK * (1 - W.adsSpreadMul);
    this.spread += (Math.min(W.spreadMax, targetSpread) - this.spread) * Math.min(1, dt * 12);

    // 换弹计时
    if (this.reloading) {
      this.reloadElapsed += dt;
      const progress = this.reloadProgress;
      if (!this.reloadInsertPlayed && progress >= W.reloadInsertRatio) {
        this.reloadInsertPlayed = true;
        this.audio.play('reload', { volume: 0.55, rate: 1.18 });
      }
      if (this.reloadElapsed >= this.reloadDuration) this._finishReload();
      this.hud.setReloadProgress(progress);
    }

    // 射击
    if (canAct && this.player && !this.player.dead) {
      // 半自动武器：仅按下边沿触发；全自动：按住连发
      let wantsFire;
      if (W.auto) {
        wantsFire = this.inputMouseDown || this.inputFirePressed;
      } else {
        wantsFire = this.inputFirePressed; // 必须松开再按
      }
      if (wantsFire && this.cooldown <= 0 && !this.reloading) {
        if (st.mag > 0) {
          this._fire();
        } else if (this.inputFirePressed) {
          this.audio.play('fireEmpty', { volume: 0.7, rate: 1 });
          this.cooldown = 0.3;
          this.hud.showReloadTip(true, true);
        }
      }
    }
    this.inputFirePressed = false;

    this.hud.setCrosshairSpread(this.spread);
    this.hud.showReloadTip(st.mag === 0 && !this.reloading, st.mag === 0);

    const speed = this.player ? Math.hypot(this.player.velocity.x, this.player.velocity.z) : 0;
    this.view.update(
      dt,
      {
        moving: speed > 1.2 && this.player && this.player.grounded,
        airborne: !!(this.player && !this.player.grounded),
        reloading: this.reloading,
        reloadProgress: this.reloadProgress,
        aiming: aimK,
      },
      mouseDelta
    );
  }

  setMouseDown(down) { this.inputMouseDown = down; }
  setFirePressed(pressed) { this.inputFirePressed = !!pressed; }

  /** 开镜状态（右键按住） */
  setAiming(on) { this.aiming = !!on; }

  // ---------------- 弹种轮盘 ----------------
  openAmmoWheel() {
    if (this.ammoWheelOpen) return;
    this.ammoWheelOpen = true;
    this._wheelAccum = 0;
    this.hud.showAmmoWheel(AMMO_TYPES, this.ammoIndex);
  }

  /** 轮盘打开时由鼠标位移驱动选择（左右/上下均可） */
  updateAmmoWheel(dx, dy) {
    if (!this.ammoWheelOpen) return;
    this._wheelAccum += Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    if (Math.abs(this._wheelAccum) >= 55) {
      const step = this._wheelAccum > 0 ? 1 : -1;
      this.ammoIndex = (this.ammoIndex + step + AMMO_TYPES.length) % AMMO_TYPES.length;
      this._wheelAccum = 0;
      this.hud.showAmmoWheel(AMMO_TYPES, this.ammoIndex);
      this._syncHud();   // HUD 弹种名实时跟随轮盘选中项
      this.audio.play('casing1', { volume: 0.15, rate: 1.5 });
    }
  }

  closeAmmoWheel() {
    if (!this.ammoWheelOpen) return;
    this.ammoWheelOpen = false;
    this.hud.hideAmmoWheel();
    this._syncHud();
    this.audio.play('casing1', { volume: 0.22, rate: 1.2 });
  }

  debugFire() {
    if (this.reloading || this._state.mag <= 0 || this.cooldown > 0) return;
    this._fire();
  }

  /** 切换到指定武器 */
  switchWeapon(id) {
    if (!WEAPON_UNLOCKED.includes(id)) return;
    if (id === this.currentId) return;
    if (this.switchCooldown > 0) return;
    if (this.reloading) this._cancelReload();

    this.currentId = id;
    const W = this._current;
    const st = this._state;
    this.cooldown = 0.25;           // 切枪后小延迟
    this.switchCooldown = 0.3;
    this.heat = 0;
    this.spread = W.spreadBase;
    this.audio.play('casing1', { volume: 0.18, rate: 1.4 }); // 切枪音效（用抛壳声代替）
    this.view.setWeapon(W);
    this._syncHud();
  }

  /** 滚轮切换 */
  switchWeaponByDelta(delta) {
    const idx = WEAPON_UNLOCKED.indexOf(this.currentId);
    let next = idx + (delta > 0 ? 1 : -1);
    if (next < 0) next = WEAPON_UNLOCKED.length - 1;
    if (next >= WEAPON_UNLOCKED.length) next = 0;
    this.switchWeapon(WEAPON_UNLOCKED[next]);
  }

  _cancelReload() {
    this.reloading = false;
    this.reloadElapsed = 0;
    this.reloadInsertPlayed = false;
    this.hud.showReloadBar(false);
  }

  /** 开火 */
  _fire() {
    const W = this._current;
    const st = this._state;
    const ammo = this.ammoType;
    const aimK = this.aimProgress;
    const recoilScale = 1 - aimK * 0.4;

    st.mag -= 1;
    this.cooldown = W.fireInterval / (this.fireRateMul || 1);
    this.shotCount += 1;
    st.burstCount += 1;
    st.heat = Math.min(8, st.heat + 0.9);

    // 后坐力（开镜时更稳）
    const ramp = Math.min(W.recoilRampMax, 1 + st.burstCount * W.recoilRamp);
    if (st.burstCount === 1) {
      this.recoilYawDir = (Math.random() - 0.5) * 2;
    }
    this.mouseLook.addRecoil(
      W.recoilPitch * ramp * recoilScale,
      (this.recoilYawDir * W.recoilYaw * ramp + (Math.random() - 0.5) * W.recoilYaw * 0.6) * recoilScale
    );
    const shakeAmp = Math.min(W.shakeMax, st.burstCount * W.shakePerShot) * recoilScale;
    this.mouseLook.addShake(
      (Math.random() - 0.5) * shakeAmp,
      (Math.random() - 0.5) * shakeAmp * 0.8
    );

    // 弹道基准方向
    const camDir = this.camera.getWorldDirection(this._tmpDir).clone();
    this._tmpRight.crossVectors(camDir, UP).normalize();
    this._tmpUp.crossVectors(this._tmpRight, camDir).normalize();

    const origin = this.camera.position.clone();
    const muzzle = this.view.getMuzzleWorldPosition();
    this._muzzle.copy(muzzle);

    // 多弹丸（霰弹枪）或穿透（重狙）—— 每颗弹丸独立射线
    const pellets = W.pellets || 1;
    const pierce = (W.pierce || 0) + (ammo.pierceAdd || 0);
    const tracerColor = W.element !== 'none' ? ELEMENTS[W.element].color : ammo.color;
    let anyHit = false;
    let anyKill = false;
    let anyHeadshot = false;

    for (let p = 0; p < pellets; p++) {
      const spread = (this.spread + (W.spread || 0)) * ammo.spreadMul;
      const r = spread * Math.sqrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const dir = camDir.clone()
        .addScaledVector(this._tmpRight, Math.cos(theta) * r)
        .addScaledVector(this._tmpUp, Math.sin(theta) * r)
        .normalize();

      const wallHit = this.collision.raycast(origin, dir, W.range);
      const effectiveRange = wallHit ? wallHit.distance : W.range;

      // 穿透模式：一枪穿过多个敌人
      let hitList;
      if (pierce > 0 && this.enemies && this.enemies.raycastAll) {
        hitList = this.enemies.raycastAll(origin, dir, effectiveRange).slice(0, pierce + 1);
      } else {
        const single = this.enemies ? this.enemies.raycast(origin, dir, effectiveRange) : null;
        hitList = single ? [single] : [];
      }

      let furthestHit = null;
      let hitEnemy = false;

      for (const enemyHit of hitList) {
        if (wallHit && enemyHit.distance >= wallHit.distance) break; // 墙挡住了
        hitEnemy = true;
        let mult = 1;
        if (enemyHit.part === 'head') mult = W.headshotMultiplier;
        else if (enemyHit.part === 'limb') mult = W.limbMultiplier;
        let damage = W.damage * mult * ammo.damageMul * (this.damageMul || 1);
        // 科研：爆头 / 首领 / 暴击加成
        if (enemyHit.part === 'head') damage *= this.headshotMulBonus || 1;
        if (enemyHit.enemy.variant?.id === 'boss') damage *= this.bossMul || 1;
        const crit = this.critChance > 0 && Math.random() < this.critChance;
        if (crit) damage *= this.critMul || 1.5;
        const killed = enemyHit.enemy.takeDamage(damage, enemyHit.head);
        const headshot = enemyHit.part === 'head';
        this.effects.spawnEnemyHit(enemyHit.point);
        this._applyBulletEffects(W, enemyHit, damage, ammo);
        if (killed) {
          this._registerKill(enemyHit.enemy, headshot);
        }
        if (!furthestHit || enemyHit.distance > furthestHit.distance) {
          furthestHit = enemyHit;
        }
      }

      let hitPoint;
      if (hitEnemy && furthestHit) {
        hitPoint = furthestHit.point;
      } else if (wallHit) {
        hitPoint = wallHit.point;
        this.effects.spawnImpact(hitPoint, wallHit.normal);
      } else {
        hitPoint = origin.clone().addScaledVector(dir, W.range);
      }

      this.effects.spawnTracer(muzzle, hitPoint, pellets > 1 ? 0.5 : 1.0, tracerColor);

      if (hitEnemy) anyHit = true;
      if (hitList.some(h => h.enemy.health <= 0)) anyKill = true;
    }

    // 命中反馈（只反馈一次，避免多弹丸重复播放）
    if (anyHit) {
      this.hud.showHitmarker(anyKill, anyHeadshot);
      this.audio.play('hit', {
        volume: anyHeadshot ? 0.75 : 0.55,
        rate: anyHeadshot ? 1.15 : 1.0,
      });
    }

    // 枪口火焰 + 音效 + 抛壳
    this.effects.spawnMuzzleFlash(muzzle, camDir);
    this.view.triggerFire();
    const sfxName = pellets > 1 ? 'fire2' : (this.shotCount % 2 === 0 ? 'fire1' : 'fire2');
    this.audio.play(sfxName, { volume: 0.85, rate: 0.94 + Math.random() * 0.12 });
    this.audio.play('casing' + (1 + (this.shotCount % 5)), { volume: 0.3, rate: 0.9 + Math.random() * 0.2 });

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const casingPos = this.camera.position.clone()
      .addScaledVector(right, 0.2)
      .addScaledVector(camDir, 0.25)
      .add(new THREE.Vector3(0, -0.12, 0));
    this.casings.spawn(casingPos, right);

    this._syncHud();
    this.onShot({ hit: anyHit, kill: anyKill, headshot: anyHeadshot });

    // 子弹落地/枪声：通知附近丧尸朝声源移动（改进寻敌机制，丧尸不会只对着空地发呆）
    if (this.enemies && this.enemies.hearAt) {
      const origin = this.camera.position.clone();
      const camDir = this.camera.getWorldDirection(this._tmpDir).clone();
      const shotPos = origin.clone().addScaledVector(camDir, 12);
      this.enemies.hearAt(shotPos);
    }
  }

  /** 击杀结算（普通命中 / 连锁 / 爆炸共用） */
  _registerKill(enemy, headshot = false, label = null) {
    this.onKill(enemy);
    const text = label || (headshot ? '爆头' : '击杀');
    this.hud.pushKill(text, '击倒');
    this.hud.showKillPopup(text);
    if (headshot) {
      this.hud.addHeadshotKill();
      this.audio.play('kill', { volume: 0.8, rate: 1.5 });
    }
  }

  /** 子弹元素 / 弹种附带的额外效果 */
  _applyBulletEffects(W, enemyHit, damage, ammo) {
    const target = enemyHit.enemy;
    const el = ELEMENTS[W.element];

    if (W.element !== 'none' && el) {
      if (el.knockback) {
        const px = this.player ? this.player.position.x : target.position.x - 1;
        const pz = this.player ? this.player.position.z : target.position.z;
        target.addKnockback(target.position.x - px, target.position.z - pz, el.knockback);
      }
      if (el.burnDps) target.applyStatus('burn', el.burnTime, el.burnDps);
      if (el.poisonDps) target.applyStatus('poison', el.poisonTime, el.poisonDps);
      if (el.slowFactor) target.applyStatus('slow', el.slowTime, el.slowFactor);
      if (el.chainCount) this._chainLightning(enemyHit, damage, el);
      if (el.comboHits) {
        this.comboHits += 1;
        if (this.comboHits >= el.comboHits) {
          this.comboHits = 0;
          this._explodeAt(enemyHit.point, el.explodeRadius, el.explodeDamage, '连爆');
        }
      }
    }

    if (ammo.explodeRadius) {
      this._explodeAt(enemyHit.point, ammo.explodeRadius, ammo.explodeDamage, '爆裂弹');
    }
  }

  /** 雷元素：向命中点附近最近的敌人连锁 */
  _chainLightning(hit, damage, el) {
    if (!this.enemies || !this.enemies.enemies) return;
    const point = hit.point;
    const targets = this.enemies.enemies
      .filter((e) => e && e !== hit.enemy && !e.dead && e.root && e.root.visible)
      .map((e) => ({ e, d: e.position.distanceTo(point) }))
      .filter((o) => o.d <= el.chainRange)
      .sort((a, b) => a.d - b.d)
      .slice(0, el.chainCount);

    for (const { e } of targets) {
      const killed = e.takeDamage(damage * el.chainMul);
      const p = e.position.clone();
      p.y += 1.0;
      this.effects.spawnEnemyHit(p);
      if (killed) this._registerKill(e, false, '连锁击杀');
    }
  }

  /** 范围爆炸（连爆 / 爆裂弹） */
  _explodeAt(point, radius, damage, label) {
    if (!this.enemies || !this.enemies.enemies) return;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root || !e.root.visible) continue;
      if (e.position.distanceTo(point) > radius) continue;
      if (e.takeDamage(damage)) this._registerKill(e, false, label);
    }
    this.effects.spawnImpact(point, this._upVec);
  }

  startReload() {
    const W = this._current;
    const st = this._state;
    if (this.reloading) return;
    if (st.mag >= W.magazineSize) return;
    if (st.reserve <= 0) return;

    this.reloading = true;
    this.reloadElapsed = 0;
    this.reloadInsertPlayed = false;
    const empty = st.mag === 0;
    this.reloadDuration = W.reloadTime * (this.reloadMul || 1);
    this.audio.play(empty ? 'reloadEmpty' : 'reload', { volume: 0.8, rate: 1 });
    this.hud.showReloadBar(true);
    this.hud.showReloadTip(false, false);
  }

  _finishReload() {
    const W = this._current;
    const st = this._state;
    const need = W.magazineSize - st.mag;
    const take = Math.min(need, st.reserve);
    st.mag += take;
    st.reserve -= take;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.hud.showReloadBar(false);
    this._syncHud();
    this.hud.showReloadTip(false, false);
  }

  addSupply(rounds) {
    // 补给加到所有武器的备弹
    for (const id of WEAPON_UNLOCKED) {
      this._states[id].reserve += Math.max(0, rounds);
    }
    this._syncHud();
  }

  /**
   * 把局外备弹库存带入本局（闯关 / 无尽）。
   * 每把武器弹匣免费装满，备弹取库存，库存上限按科研加成放大。
   */
  applyAmmoStock(stock = {}, capMul = 1) {
    for (const id of WEAPON_UNLOCKED) {
      const st = this._states[id];
      const cap = Math.round((AMMO_SHOP[id]?.cap || 120) * capMul);
      st.mag = this.weapons[id].magazineSize;
      st.reserve = Math.min(cap, Math.max(0, Math.floor(stock[id] || 0)));
      st.heat = 0;
      st.burstCount = 0;
    }
    this._syncHud();
  }

  /** 将本局剩余备弹写回局外库存（进入结算时调用） */
  collectAmmoStock() {
    const out = {};
    for (const id of WEAPON_UNLOCKED) {
      out[id] = Math.max(0, Math.floor(this._states[id].reserve));
    }
    return out;
  }

  resetAmmo() {
    for (const id of WEAPON_UNLOCKED) {
      const w = this.weapons[id];
      this._states[id].mag = w.magazineSize;
      this._states[id].reserve = w.reserveAmmo;
      this._states[id].heat = 0;
      this._states[id].burstCount = 0;
    }
    this.reloading = false;
    this.reloadElapsed = 0;
    this.cooldown = 0;
    this.reloadInsertPlayed = false;
    this.aiming = false;
    this.aimProgress = 0;
    this.comboHits = 0;
    this.hud.showReloadBar(false);
    this._syncHud();
  }

  /** 同步 HUD 弹药 + 武器名 + 弹种 */
  _syncHud() {
    const W = this._current;
    const st = this._state;
    const ammo = this.ammoType;
    this.hud.setAmmo(st.mag, st.reserve);
    this.hud.setWeaponName(W.name, W.tag);
    this.hud.setAmmoType(ammo.name, ammo.color);
  }
}
