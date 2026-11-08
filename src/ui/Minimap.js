/**
 * 小地图雷达（2D Canvas）
 *
 * 固定北朝上，显示：
 *   - 玩家三角形 + FOV 扇形（基于相机 yaw）
 *   - 敌人方块（boss 用大圆点 + 橙色）
 *   - 出生点 / 关键位置小点
 *   - 地图边界框
 */
export class Minimap {
  constructor({ canvas, mapBounds = { minX: -30, maxX: 30, minZ: -25, maxZ: 25 } } = {}) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'minimap';
      canvas.width = 160;
      canvas.height = 160;
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bounds = mapBounds;
    this.range = Math.max(
      this.bounds.maxX - this.bounds.minX,
      this.bounds.maxZ - this.bounds.minZ
    );
    this.center = {
      x: (this.bounds.minX + this.bounds.maxX) / 2,
      z: (this.bounds.minZ + this.bounds.maxZ) / 2,
    };
  }

  /**
   * 每帧绘制雷达。
   * @param {Object} opts
   * @param {import('three').Vector3} opts.playerPos
   * @param {number} opts.playerYaw  弧度（绕 Y 轴朝向）
   * @param {Array}  opts.enemies   EnemyAI 实例数组
   * @param {Array}  opts.spawnPoints  [{x, z}, ...] 敌人出生点（可选）
   */
  draw({ playerPos, playerYaw, enemies = [], spawnPoints = [] }) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    // 缩放到 canvas（世界单位 → 像素）
    const scale = w / this.range;

    // 清屏：深色背景 + 边框
    ctx.fillStyle = 'rgba(10, 12, 20, 0.85)';
    ctx.fillRect(0, 0, w, h);

    // 地图边界框
    ctx.strokeStyle = 'rgba(120, 160, 200, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      (this.bounds.minX - this.center.x) * scale + cx,
      (this.bounds.minZ - this.center.z) * scale + cy,
      (this.bounds.maxX - this.bounds.minX) * scale,
      (this.bounds.maxZ - this.bounds.minZ) * scale
    );

    // 网格（3 米格）
    ctx.strokeStyle = 'rgba(80, 100, 140, 0.18)';
    ctx.lineWidth = 1;
    const step = 6;
    for (let gx = Math.floor(this.bounds.minX / step) * step; gx <= this.bounds.maxX; gx += step) {
      const x = (gx - this.center.x) * scale + cx;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let gz = Math.floor(this.bounds.minZ / step) * step; gz <= this.bounds.maxZ; gz += step) {
      const y = (gz - this.center.z) * scale + cy;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // 出生点（暗色小点）
    if (spawnPoints.length) {
      ctx.fillStyle = 'rgba(180, 140, 100, 0.45)';
      for (const sp of spawnPoints) {
        const px = (sp.x - this.center.x) * scale + cx;
        const py = (sp.z - this.center.z) * scale + cy;
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
    }

    // 敌人（注意 Three.js 里 z 是深度轴，屏幕上需要翻一下 — 我们用 z 作为 Y）
    for (const e of enemies) {
      if (!e || e.dead || !e.root || !e.root.visible) continue;
      if (!e.position) continue;
      const px = (e.position.x - this.center.x) * scale + cx;
      const py = (e.position.z - this.center.z) * scale + cy;

      const variant = e.variant?.id || 'walker';
      if (variant === 'boss') {
        // boss：大圆点 + 橙色 + 脉动
        ctx.fillStyle = '#ff8a3a';
        ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255, 138, 58, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.stroke();
      } else if (variant === 'brute' || variant === 'fat') {
        ctx.fillStyle = '#ff524a';
        ctx.fillRect(px - 3, py - 3, 6, 6);
      } else if (variant === 'swift' || variant === 'runner') {
        ctx.fillStyle = '#ffcc44';
        ctx.fillRect(px - 2, py - 2, 4, 4);
      } else {
        ctx.fillStyle = '#ff4444';
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
    }

    // 玩家
    if (playerPos) {
      const ppx = (playerPos.x - this.center.x) * scale + cx;
      const ppy = (playerPos.z - this.center.z) * scale + cy;

      // FOV 扇形（60°）
      const fovHalf = Math.PI / 6;
      const yaw = playerYaw || 0;
      const rangeRad = 28 * scale;
      ctx.fillStyle = 'rgba(120, 200, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(ppx, ppy);
      ctx.arc(ppx, ppy, rangeRad, -yaw - fovHalf + Math.PI, -yaw + fovHalf + Math.PI, false);
      ctx.closePath();
      ctx.fill();

      // 玩家三角形（指向 yaw 方向）
      ctx.save();
      ctx.translate(ppx, ppy);
      ctx.rotate(-yaw + Math.PI / 2);  // canvas y 轴向下，Three.js z 朝前
      ctx.fillStyle = '#7fcfff';
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 5);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // 玩家位置圆点（确保可见）
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(ppx, ppy, 2, 0, Math.PI * 2); ctx.fill();
    }

    // 指北箭头
    ctx.fillStyle = 'rgba(200, 220, 255, 0.8)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 10);

    // 边框（四角装饰）
    ctx.strokeStyle = 'rgba(127, 207, 255, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  resize(bounds) {
    if (bounds) {
      this.bounds = bounds;
      this.range = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      this.center = {
        x: (bounds.minX + bounds.maxX) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
      };
    }
  }
}
