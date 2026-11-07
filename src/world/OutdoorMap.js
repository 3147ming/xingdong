/**
 * 关卡地图（入口）
 *
 * P1 起，所有地图构建逻辑都搬到了 MapBuilder，本文件只负责：
 *  - 取关卡布局数据（src/world/levels.js）
 *  - 交给 MapBuilder 构建
 *  - 暴露 Game 需要的 playerSpawn / waypoints / group
 *
 * 想新增关卡：在 levels.js 里加配置，不需要改这里。
 */
import { MapBuilder } from './MapBuilder.js';
import { getLevel } from './levels.js';

export class OutdoorMap {
  /**
   * @param {THREE.Scene} scene
   * @param {CollisionWorld} collision
   * @param {object} assets
   * @param {number} levelIndex 关卡索引（0 起）
   */
  constructor(scene, collision, assets, levelIndex = 0) {
    this.scene = scene;
    this.collision = collision;
    this.assets = assets;
    this.level = getLevel(levelIndex);
    this.builder = new MapBuilder(scene, collision, assets, this.level);
  }

  build() {
    this.builder.build();
    this.group = this.builder.group;
    this.playerSpawn = this.builder.playerSpawn;
    this.waypoints = this.builder.waypoints;
    this.spawnPoints = this.builder.spawnPoints;
    this.explodables = this.builder.explodables;   // 油桶 / 汽车等可爆炸物
    return this;
  }
}
