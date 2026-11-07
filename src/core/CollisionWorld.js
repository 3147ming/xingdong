/**
 * 碰撞世界：轴对齐包围盒（AABB）集合
 * - 角色移动采用“分轴移动 + 推出”的简化方案（FPS 常用且稳定）
 * - 射线检测使用 slab 算法，供射击、AI 视线判断复用
 */
import * as THREE from 'three';

export class CollisionWorld {
  constructor() {
    this.boxes = []; // { min: Vector3, max: Vector3, tag: string }
  }

  /** 清空全部碰撞盒（切换地图时重建世界） */
  clear() {
    this.boxes.length = 0;
  }

  /** 以中心点 + 尺寸添加碰撞盒 */
  addBox(cx, cy, cz, sx, sy, sz, tag = 'wall') {
    const box = {
      min: new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
      max: new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
      tag,
    };
    this.boxes.push(box);
    return box;
  }

  /**
   * 角色移动（脚底中心点坐标）
   * @param {THREE.Vector3} pos 脚底位置（会被原地修改）
   * @param {THREE.Vector3} vel 速度（会被修改）
   * @param {number} dt 帧时间
   * @param {number} radius 水平半径
   * @param {number} height 碰撞体高度
   * @returns {{grounded:boolean, hitWall:boolean}}
   */
  moveCharacter(pos, vel, dt, radius, height) {
    let grounded = false;
    let hitWall = false;

    // ---- X 轴 ----
    pos.x += vel.x * dt;
    for (const b of this.boxes) {
      if (this._overlaps(pos, radius, height, b)) {
        if (vel.x > 0) pos.x = b.min.x - radius - 0.001;
        else if (vel.x < 0) pos.x = b.max.x + radius + 0.001;
        vel.x = 0;
        hitWall = true;
      }
    }

    // ---- Z 轴 ----
    pos.z += vel.z * dt;
    for (const b of this.boxes) {
      if (this._overlaps(pos, radius, height, b)) {
        if (vel.z > 0) pos.z = b.min.z - radius - 0.001;
        else if (vel.z < 0) pos.z = b.max.z + radius + 0.001;
        vel.z = 0;
        hitWall = true;
      }
    }

    // ---- Y 轴 ----
    pos.y += vel.y * dt;
    for (const b of this.boxes) {
      if (this._overlaps(pos, radius, height, b)) {
        if (vel.y <= 0) {
          // 下落：站到盒子顶部
          pos.y = b.max.y + 0.001;
          grounded = true;
        } else {
          // 上升：顶到盒子底部
          pos.y = b.min.y - height - 0.001;
        }
        vel.y = 0;
      }
    }

    // 地图地面（y = 0）
    if (pos.y <= 0) {
      pos.y = 0;
      if (vel.y < 0) vel.y = 0;
      grounded = true;
    }

    // 站立检测（轻微向下探测，保证走下平台后能立即恢复重力）
    if (!grounded && vel.y <= 0.01) {
      const probe = pos.clone();
      probe.y -= 0.06;
      for (const b of this.boxes) {
        if (this._overlaps(probe, radius, height, b)) {
          grounded = true;
          break;
        }
      }
    }

    return { grounded, hitWall };
  }

  /** 角色 AABB 与碰撞盒是否重叠（脚底向上抬 2cm，避免贴地误判） */
  _overlaps(pos, radius, height, b) {
    const minY = pos.y + 0.02;
    return (
      pos.x + radius > b.min.x &&
      pos.x - radius < b.max.x &&
      minY < b.max.y &&
      pos.y + height > b.min.y &&
      pos.z + radius > b.min.z &&
      pos.z - radius < b.max.z
    );
  }

  /**
   * 射线检测（返回最近命中）
   * @returns {null|{distance:number, point:THREE.Vector3, normal:THREE.Vector3, tag:string}}
   */
  raycast(origin, dir, maxDist = Infinity) {
    let best = null;
    for (const b of this.boxes) {
      const hit = this._rayBox(origin, dir, b, maxDist);
      if (hit && (!best || hit.distance < best.distance)) {
        best = {
          distance: hit.distance,
          point: origin.clone().addScaledVector(dir, hit.distance),
          normal: hit.normal,
          tag: b.tag,
          box: b,
        };
      }
    }
    return best;
  }

  /** slab 算法：射线与 AABB 求交 */
  _rayBox(origin, dir, b, maxDist) {
    let tmin = 0;
    let tmax = maxDist;
    let normalAxis = -1;
    let sign = 0;

    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      const axis = axes[i];
      const o = origin[axis];
      const d = dir[axis];
      const lo = b.min[axis];
      const hi = b.max[axis];

      if (Math.abs(d) < 1e-8) {
        if (o < lo || o > hi) return null;
        continue;
      }

      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1; t1 = t2; t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        normalAxis = i;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (normalAxis === -1) return null;

    const normal = new THREE.Vector3();
    normal[axes[normalAxis]] = sign;
    return { distance: tmin, normal };
  }

  /** 两点之间是否被遮挡（AI 视线判断） */
  lineOfSight(from, to) {
    const dir = to.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.001) return true;
    dir.normalize();
    const hit = this.raycast(from, dir, dist - 0.2);
    return !hit;
  }

  /**
   * 第三轮：指定位置能否容纳给定高度的角色（蹲伏起身检测）
   * 用于防止松开蹲伏时头顶被矮掩体卡住
   */
  canFit(pos, radius, height) {
    for (const b of this.boxes) {
      if (this._overlaps(pos, radius, height, b)) return false;
    }
    return true;
  }

  /**
   * 跳跃翻越探测：正前方是否有可以站上去的矮障碍（箱体 / 矮墙 / 集装箱）
   * @param {THREE.Vector3} pos 脚底位置
   * @param {number} dirX 朝向 X（无需归一化）
   * @param {number} dirZ 朝向 Z
   * @param {number} radius 角色半径
   * @param {number} height 碰撞体高度
   * @param {number} maxRise 最大可翻越高度差
   * @returns {number|null} 可落脚顶面高度
   */
  findVaultTop(pos, dirX, dirZ, radius, height, maxRise = 2.65) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return null;
    // 探针点落在角色前方一个身位，要求落在盒顶内侧
    const px = pos.x + (dirX / len) * (radius + 0.4);
    const pz = pos.z + (dirZ / len) * (radius + 0.4);
    let top = null;
    for (const b of this.boxes) {
      if (b.tag === 'floor') continue;
      const rise = b.max.y - pos.y;
      if (rise < 0.25 || rise > maxRise) continue;
      if (px <= b.min.x + 0.05 || px >= b.max.x - 0.05 ||
          pz <= b.min.z + 0.05 || pz >= b.max.z - 0.05) continue;
      // 顶面必须站得下（避免翻越后头顶卡进堆叠物）
      if (!this.canFit(new THREE.Vector3(px, b.max.y + 0.002, pz), radius, height)) continue;
      if (top == null || b.max.y < top) top = b.max.y;
    }
    return top;
  }
}
