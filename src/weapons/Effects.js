/**
 * 射击特效对象池：曳光弹、命中火花、血液飞溅、枪口粒子、墙面弹痕
 * 使用对象池避免频繁创建/销毁导致 GC 卡顿；所有池均有固定上限，防止粒子爆炸掉帧。
 */
import * as THREE from 'three';

function glowTexture(colorStops) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  for (const [stop, color] of colorStops) g.addColorStop(stop, color);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 31, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 材质化弹痕贴图：金属 / 混凝土 / 木头 / 玻璃各一套。
 * 参考作把弹孔按材质区分，命中反馈立刻可读 —— 打到油桶是金属撕裂的亮边，
 * 打到混凝土是灰白粉尘坑，打到木箱是木屑翻起，打到玻璃是放射状白裂纹。
 */
function decalTextureFor(surface) {
  const S = 128;
  const C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  /** 不规则多边形（弹孔外形） */
  const blob = (radius, wobble, points = 13) => {
    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      const r = radius * (1 + (Math.random() - 0.5) * wobble);
      const x = C + Math.cos(a) * r;
      const y = C + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  /** 从中心向外的放射状细线 */
  const spokes = (count, r0, r1, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const end = r1 * (0.55 + Math.random() * 0.6);
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0);
      ctx.lineTo(C + Math.cos(a) * end, C + Math.sin(a) * end);
      ctx.stroke();
    }
  };

  const dust = (r, inner, outer) => {
    const g = ctx.createRadialGradient(C, C, r * 0.35, C, C, r);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(C, C, r, 0, Math.PI * 2);
    ctx.fill();
  };

  if (surface === 'metal') {
    dust(C * 0.96, 'rgba(150,158,166,0.20)', 'rgba(120,128,136,0)');
    // 金属翻边：亮银高光 + 深色撕裂口
    blob(C * 0.40, 0.55);
    ctx.fillStyle = 'rgba(196,204,212,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(246,250,255,0.85)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    blob(C * 0.26, 0.35, 11);
    ctx.fillStyle = '#08090a';
    ctx.fill();
    spokes(9, C * 0.3, C * 0.75, 'rgba(230,238,246,0.7)', 1.1);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = C * (0.35 + Math.random() * 0.5);
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(220,228,236,0.8)' : 'rgba(30,32,34,0.7)';
      ctx.beginPath();
      ctx.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, 0.8 + Math.random() * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (surface === 'wood') {
    // 木屑翻起：浅棕放射薄片
    spokes(14, C * 0.18, C * 0.9, 'rgba(214,186,138,0.75)', 2.0);
    spokes(8, C * 0.2, C * 0.62, 'rgba(126,92,54,0.7)', 1.4);
    ctx.strokeStyle = 'rgba(88,62,34,0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(C, C, C * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    blob(C * 0.3, 0.5, 10);
    ctx.fillStyle = 'rgba(34,22,12,0.92)';
    ctx.fill();
    dust(C * 0.34, 'rgba(40,26,14,0.9)', 'rgba(40,26,14,0)');
  } else if (surface === 'glass') {
    dust(C * 0.9, 'rgba(226,240,248,0.16)', 'rgba(226,240,248,0)');
    spokes(16, C * 0.08, C * 0.95, 'rgba(244,250,255,0.9)', 0.9);
    ctx.strokeStyle = 'rgba(238,248,255,0.65)';
    for (let ring = 1; ring <= 3; ring++) {
      const r = C * (0.2 + ring * 0.2);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(C, C, r, Math.random() * 0.8, Math.PI * 0.55 + Math.random() * 1.2);
      ctx.stroke();
    }
    blob(C * 0.14, 0.4, 9);
    ctx.fillStyle = 'rgba(18,26,30,0.85)';
    ctx.fill();
  } else {
    // 混凝土：灰白粉尘 + 深坑 + 细裂纹
    dust(C * 0.98, 'rgba(206,202,192,0.30)', 'rgba(196,192,182,0)');
    spokes(11, C * 0.28, C * 0.86, 'rgba(52,50,46,0.55)', 1.0);
    blob(C * 0.42, 0.6, 14);
    ctx.fillStyle = 'rgba(150,146,138,0.5)';
    ctx.fill();
    blob(C * 0.3, 0.5, 12);
    ctx.fillStyle = 'rgba(44,42,38,0.9)';
    ctx.fill();
    blob(C * 0.17, 0.3, 9);
    ctx.fillStyle = '#0b0b0a';
    ctx.fill();
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = C * (0.5 + Math.random() * 0.55);
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(198,194,184,0.55)' : 'rgba(38,36,33,0.5)';
      ctx.beginPath();
      ctx.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, 0.6 + Math.random() * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // 曳光弹池
    this.tracerPool = [];
    for (let i = 0; i < 12; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3(),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd889, transparent: true, opacity: 0, depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.tracerPool.push({ line, life: 0, maxLife: 0.06 });
    }

    // 火花贴图
    const sparkTex = glowTexture([
      [0, 'rgba(255,255,230,1)'],
      [0.35, 'rgba(255,200,90,0.8)'],
      [1, 'rgba(255,120,0,0)'],
    ]);
    this.sparkPool = [];
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.SpriteMaterial({
        map: sparkTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.sparkPool.push({ sprite: s, life: 0, maxLife: 0.22, baseScale: 0.12 });
    }

    // 血液贴图
    const bloodTex = glowTexture([
      [0, 'rgba(210,20,20,0.95)'],
      [0.5, 'rgba(140,0,0,0.6)'],
      [1, 'rgba(90,0,0,0)'],
    ]);
    this.bloodPool = [];
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.SpriteMaterial({
        map: bloodTex, transparent: true, depthWrite: false, opacity: 0,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.bloodPool.push({ sprite: s, life: 0, maxLife: 0.4, vx: 0, vy: 0, vz: 0 });
    }

    // 浓烟粒子池（爆炸后上升扩散，半透明深灰）
    const smokeTex = glowTexture([
      [0, 'rgba(90,90,90,0.45)'],
      [0.5, 'rgba(60,60,60,0.2)'],
      [1, 'rgba(40,40,40,0)'],
    ]);
    this.smokePool = [];
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTex, transparent: true, opacity: 0,
        depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.smokePool.push({ sprite: s, life: 0, maxLife: 3.0, vx: 0, vy: 0, vz: 0, baseScale: 1.0 });
    }

    // 地面焦黑贴花池（贴在地面，缓慢淡出）
    const burnTex = glowTexture([
      [0, 'rgba(30,25,20,0.6)'],
      [0.5, 'rgba(60,45,35,0.35)'],
      [1, 'rgba(90,70,55,0)'],
    ]);
    this.burnMarkPool = [];
    const burnGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: burnTex, transparent: true, opacity: 0,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
      });
      const mesh = new THREE.Mesh(burnGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this.burnMarkPool.push({ mesh, life: 0, maxLife: 12.0 });
    }

    // 枪口粒子池（短寿命、加法混合）
    this.muzzlePool = [];
    const muzzleTex = glowTexture([
      [0, 'rgba(255,255,240,1)'],
      [0.4, 'rgba(255,190,80,0.85)'],
      [1, 'rgba(255,90,0,0)'],
    ]);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.SpriteMaterial({
        map: muzzleTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.frustumCulled = false;
      scene.add(s);
      this.muzzlePool.push({ sprite: s, life: 0, maxLife: 0.12, vx: 0, vy: 0, vz: 0, baseScale: 0.2 });
    }

    // 墙面弹痕池（按命中材质换贴图，自动淡出）
    this.decalPool = [];
    this.decalTextures = {
      metal: decalTextureFor('metal'),
      concrete: decalTextureFor('concrete'),
      wood: decalTextureFor('wood'),
      glass: decalTextureFor('glass'),
    };
    const decalGeo = new THREE.PlaneGeometry(0.17, 0.17);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.decalTextures.concrete, transparent: true, opacity: 0,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(decalGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this.decalPool.push({ mesh, life: 0, maxLife: 8.0 });
    }
  }

  _getTracer() {
    return this.tracerPool.find((t) => t.life <= 0) || this.tracerPool[0];
  }

  _getSpark() {
    return this.sparkPool.find((t) => t.life <= 0) || this.sparkPool[0];
  }

  _getBlood() {
    return this.bloodPool.find((t) => t.life <= 0) || this.bloodPool[0];
  }

  _getMuzzle() {
    return this.muzzlePool.find((t) => t.life <= 0) || this.muzzlePool[0];
  }

  _getDecal() {
    return this.decalPool.find((d) => d.life <= 0) || this.decalPool[0];
  }

  _getSmoke() {
    return this.smokePool.find((s) => s.life <= 0) || this.smokePool[0];
  }

  _getBurnMark() {
    return this.burnMarkPool.find((b) => b.life <= 0) || this.burnMarkPool[0];
  }

  /** 子弹曳光（起点 -> 终点；color 用于元素弹着色） */
  spawnTracer(from, to, opacity = 0.85, color = 0xffd889) {
    const item = this._getTracer();
    const attr = item.line.geometry.attributes.position;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    item.line.material.opacity = opacity;
    item.line.material.color.setHex(color);
    item.line.visible = true;
    item.life = item.maxLife;
  }

  /**
   * 命中墙面：火花 + 材质化弹痕
   * @param {THREE.Vector3} point 命中点
   * @param {THREE.Vector3} normal 命中面法线
   * @param {'metal'|'concrete'|'wood'|'glass'} [surface] 被击中的材质
   */
  spawnImpact(point, normal, surface = 'concrete') {
    const item = this._getSpark();
    const offset = normal ? normal.clone().multiplyScalar(0.03) : new THREE.Vector3();
    item.sprite.position.copy(point).add(offset);
    item.sprite.scale.setScalar(item.baseScale);
    item.sprite.material.opacity = 1;
    item.sprite.visible = true;
    item.life = item.maxLife;

    // 弹痕贴在墙面，朝向法线并随机旋转，8 秒后淡出
    const decal = this._getDecal();
    const n = normal ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
    decal.mesh.position.copy(point).addScaledVector(n, 0.012);
    decal.mesh.lookAt(point.clone().add(n));
    decal.mesh.rotateZ(Math.random() * Math.PI * 2);
    // 金属 / 玻璃弹痕偏小，混凝土坑更大
    const size = surface === 'metal' || surface === 'glass' ? 0.75 : 1.0;
    decal.mesh.scale.setScalar(size * (0.8 + Math.random() * 0.5));
    const tex = this.decalTextures[surface] || this.decalTextures.concrete;
    if (decal.mesh.material.map !== tex) decal.mesh.material.map = tex;
    decal.mesh.material.opacity = 0.95;
    decal.mesh.visible = true;
    decal.life = decal.maxLife;
  }

  /** 命中敌人的血液飞溅（红色粒子） */
  spawnBlood(point) {
    for (let i = 0; i < 4; i++) {
      const item = this._getBlood();
      item.sprite.position.copy(point);
      item.sprite.scale.setScalar(0.08 + Math.random() * 0.1);
      item.sprite.material.opacity = 0.9;
      item.sprite.visible = true;
      item.life = item.maxLife;
      item.vx = (Math.random() - 0.5) * 0.9;
      item.vy = Math.random() * 0.7 + 0.2;
      item.vz = (Math.random() - 0.5) * 0.9;
    }
  }

  /** 命中敌人：更密集的红色受击粒子 */
  spawnEnemyHit(point) {
    this.spawnBlood(point);
    for (let i = 0; i < 4; i++) {
      const item = this._getBlood();
      item.sprite.position.copy(point);
      item.sprite.scale.setScalar(0.05 + Math.random() * 0.08);
      item.sprite.material.opacity = 0.85;
      item.sprite.visible = true;
      item.life = item.maxLife;
      item.vx = (Math.random() - 0.5) * 1.6;
      item.vy = Math.random() * 1.1 + 0.2;
      item.vz = (Math.random() - 0.5) * 1.6;
    }
  }

  /** 枪口粒子火焰：沿枪口方向喷出 3 个粒子 */
  spawnMuzzleFlash(position, dir) {
    for (let i = 0; i < 3; i++) {
      const item = this._getMuzzle();
      item.sprite.position.copy(position);
      item.sprite.scale.setScalar(item.baseScale * (0.7 + Math.random() * 0.6));
      item.sprite.material.opacity = 1;
      item.sprite.visible = true;
      item.life = item.maxLife;
      const spread = 0.35;
      item.vx = dir.x * 2.2 + (Math.random() - 0.5) * spread;
      item.vy = dir.y * 2.2 + (Math.random() - 0.5) * spread;
      item.vz = dir.z * 2.2 + (Math.random() - 0.5) * spread;
    }
  }

  /** 自爆丧尸爆炸：火球 + 火星向外扩散 */
  spawnExplosion(center, radius) {
    // 火球核心（多个 muzzle 粒子叠加）
    for (let i = 0; i < 8; i++) {
      const item = this._getMuzzle();
      item.sprite.position.copy(center);
      item.sprite.position.y += 0.5;
      item.sprite.scale.setScalar(item.baseScale * (2.5 + Math.random() * 2));
      item.sprite.material.opacity = 1;
      item.sprite.visible = true;
      item.life = item.maxLife * 1.5;
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 2.5;
      item.vx = Math.cos(ang) * sp;
      item.vy = 0.5 + Math.random() * 1.5;
      item.vz = Math.sin(ang) * sp;
    }
    // 火星飞溅
    for (let i = 0; i < 12; i++) {
      const item = this._getSpark();
      item.sprite.position.copy(center);
      item.sprite.position.y += 0.5;
      item.sprite.scale.setScalar(item.baseScale * (1.5 + Math.random()));
      item.sprite.material.opacity = 1;
      item.sprite.visible = true;
      item.life = item.maxLife * 2;
      const ang = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 5;
      item.sprite.position.x += Math.cos(ang) * 0.3;
      item.sprite.position.z += Math.sin(ang) * 0.3;
      // 复用 spark 的 vx/vy/vz（在 update 里处理）
      item.vx = Math.cos(ang) * sp;
      item.vy = 1 + Math.random() * 2.5;
      item.vz = Math.sin(ang) * sp;
    }
  }

  /** 爆炸后浓烟：向四周散开后缓慢上升扩散 */
  spawnSmoke(center, radius = 5) {
    for (let i = 0; i < 8; i++) {
      const item = this._getSmoke();
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * radius * 0.5;
      item.sprite.position.set(
        center.x + Math.cos(ang) * r,
        center.y + 0.4 + Math.random() * 0.8,
        center.z + Math.sin(ang) * r
      );
      item.sprite.scale.setScalar(item.baseScale * (0.9 + Math.random() * 0.8));
      item.sprite.material.opacity = 0.55 + Math.random() * 0.25;
      item.sprite.visible = true;
      item.life = item.maxLife * (0.7 + Math.random() * 0.5);
      const sp = 0.3 + Math.random() * 0.9;
      item.vx = Math.cos(ang) * sp;
      item.vy = 0.5 + Math.random() * 1.1;
      item.vz = Math.sin(ang) * sp;
    }
  }

  /** 地面焦黑贴花：贴地（y≈0.02）随机旋转，缓慢淡出 */
  spawnBurnMark(center, radius = 4.5) {
    const item = this._getBurnMark();
    item.mesh.position.set(center.x, 0.022, center.z);
    item.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    item.mesh.scale.setScalar(radius * 1.6 * (0.8 + Math.random() * 0.35));
    item.mesh.material.opacity = 0.85;
    item.mesh.visible = true;
    item.life = item.maxLife;
  }

  /** 每帧更新 */
  update(dt) {
    for (const t of this.tracerPool) {
      if (t.life > 0) {
        t.life -= dt;
        t.line.material.opacity = Math.max(0, t.life / t.maxLife) * 0.85;
        if (t.life <= 0) t.line.visible = false;
      }
    }
    for (const s of this.sparkPool) {
      if (s.life > 0) {
        s.life -= dt;
        const k = s.life / s.maxLife;
        s.sprite.material.opacity = k;
        s.sprite.scale.setScalar(s.baseScale * (1.6 - k * 0.6));
        // 爆炸火星带速度时更新位置
        if (s.vx || s.vy || s.vz) {
          s.sprite.position.x += s.vx * dt;
          s.sprite.position.y += (s.vy -= 3.0 * dt) * dt;
          s.sprite.position.z += s.vz * dt;
        }
        if (s.life <= 0) { s.sprite.visible = false; s.vx = s.vy = s.vz = 0; }
      }
    }
    for (const b of this.bloodPool) {
      if (b.life > 0) {
        b.life -= dt;
        const k = b.life / b.maxLife;
        b.sprite.material.opacity = k * 0.9;
        b.sprite.position.x += b.vx * dt;
        b.sprite.position.y += (b.vy -= 2.2 * dt) * dt;
        b.sprite.position.z += b.vz * dt;
        if (b.life <= 0) b.sprite.visible = false;
      }
    }
    for (const m of this.muzzlePool) {
      if (m.life > 0) {
        m.life -= dt;
        const k = m.life / m.maxLife;
        m.sprite.material.opacity = k;
        m.sprite.position.x += m.vx * dt;
        m.sprite.position.y += m.vy * dt;
        m.sprite.position.z += m.vz * dt;
        m.sprite.scale.setScalar(0.2 * (0.5 + k));
        if (m.life <= 0) m.sprite.visible = false;
      }
    }
    for (const d of this.decalPool) {
      if (d.life > 0) {
        d.life -= dt;
        // 最后 2 秒淡出
        d.mesh.material.opacity = Math.min(0.95, d.life / 2) ;
        if (d.life <= 0) d.mesh.visible = false;
      }
    }
    for (const s of this.smokePool) {
      if (s.life > 0) {
        s.life -= dt;
        const k = s.life / s.maxLife;
        // 边升边扩散、边变淡
        s.sprite.material.opacity = Math.min(0.7, k * 0.9);
        s.sprite.scale.setScalar(s.sprite.scale.x + dt * 1.6);
        s.sprite.position.x += s.vx * dt;
        s.sprite.position.y += s.vy * dt;
        s.sprite.position.z += s.vz * dt;
        // 上升速度逐渐衰减
        s.vy *= 1 - dt * 0.45;
        s.vx *= 1 - dt * 0.6;
        s.vz *= 1 - dt * 0.6;
        if (s.life <= 0) s.sprite.visible = false;
      }
    }
    for (const b of this.burnMarkPool) {
      if (b.life > 0) {
        b.life -= dt;
        b.mesh.material.opacity = 0.85 * Math.min(1, b.life / 4);
        if (b.life <= 0) b.mesh.visible = false;
      }
    }
  }
}
