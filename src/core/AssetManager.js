/**
 * 资源管理器
 * 统一加载仓库中复用的 FBX 模型 / 贴图，并提供加载进度。
 * 使用 THREE.LoadingManager 重定向 FBX 内部引用的贴图路径，
 * 避免浏览器去请求 Unity 工程里的绝对路径（会 404）。
 */
import * as THREE from 'three';
import { FBXLoader } from '../../vendor/three/loaders/FBXLoader.js';
import { TGALoader } from '../../vendor/three/loaders/TGALoader.js';
import { GLTFLoader } from '../../vendor/three/loaders/GLTFLoader.js';

const TEX_DIR = './public/assets/textures/';
const MODEL_DIR = './public/assets/models/';

// 1x1 透明占位贴图（用于屏蔽 FBX 中不需要的法线/高光贴图请求）
const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class AssetManager {
  constructor() {
    this.manager = new THREE.LoadingManager();
    this.fbx = new FBXLoader(this.manager);
    this.gltf = new GLTFLoader(this.manager);
    this.tex = new THREE.TextureLoader(this.manager);
    this.tga = new TGALoader(this.manager);
    this.assets = {};

    // 贴图路径重定向：FBX 内部写的是 Unity 工程的绝对/相对路径
    this.manager.setURLModifier((url) => {
      if (url.startsWith('data:')) return url;
      const name = url.split(/[\\/]/).pop().toLowerCase();
      // 仅对贴图扩展名做重定向，避免误伤 zombie.fbx 等同名模型
      const isTex = /\.(jpg|jpeg|png|tga|bmp|dds|psd|webp)$/.test(name);

      // ⚠ 项目自身的 WebP 贴图必须原样放行。
      // 早期版本漏了这一步，导致 _tex() 显式请求的 ak74/arm 贴图被下面
      // 的 "其余贴图一律返回占位图" 分支替换成 1×1 透明 PNG，
      // 武器最终渲染成一块没有纹理的纯色模型。
      if (isTex && /\.webp$/.test(name)) return url;

      // 项目自身提供的贴图已压缩为 WebP，统一重定向到 textures 目录
      if (isTex && (name === 'ak74_color.jpg' || name.startsWith('ak74color'))) return TEX_DIR + 'ak74_color.webp';
      if (isTex && (name === 'arm_color.jpg' || name.startsWith('armcolor'))) return TEX_DIR + 'arm_color.webp';
      if (isTex && (name === 'zombie.tga' || name.startsWith('zombie'))) return TEX_DIR + 'zombie.webp';
      // 其余 FBX 引用的法线/金属度/UV 等贴图网页版不需要，返回占位图避免 404
      if (isTex) return PLACEHOLDER;
      return url;
    });
  }

  _tex(path, isTga = false) {
    return new Promise((resolve, reject) => {
      const loader = isTga ? this.tga : this.tex;
      loader.load(path, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve(t);
      }, undefined, reject);
    });
  }

  _fbx(path) {
    return new Promise((resolve, reject) => {
      this.fbx.load(path, resolve, undefined, reject);
    });
  }

  _gltf(path) {
    return new Promise((resolve, reject) => {
      this.gltf.load(path, resolve, undefined, reject);
    });
  }

  /** 从 gltf 中提取 scene（GLB 里主场景） */
  _gltfScene(path) {
    return new Promise((resolve, reject) => {
      this.gltf.load(path, (gltf) => resolve(gltf.scene), undefined, reject);
    });
  }

  /** 第一人称武器：优先使用带手臂的 AK 模型，解析失败时回退到 Unity 示例武器 */
  async _loadWeapon() {
    try {
      return await this._fbx(MODEL_DIR + 'weapon_arms.fbx');
    } catch (err) {
      console.warn('[AssetManager] 手臂武器模型解析失败，回退到备用武器模型:', err);
      return await this._fbx(MODEL_DIR + 'fps_weapon.fbx');
    }
  }

  /**
   * 加载全部资源
   * @param {(percent:number)=>void} onProgress
   */
  async loadAll(onProgress) {
    const tasks = [
      ['weaponModel', () => this._loadWeapon()],
      ['weaponPistol', () => this._gltfScene(MODEL_DIR + 'weapons/pistol.glb')],
      ['weaponShotgun', () => this._gltfScene(MODEL_DIR + 'weapons/shotgun.glb')],
      ['weaponSniper', () => this._gltfScene(MODEL_DIR + 'weapons/sniper.glb')],
      ['weaponSmg', () => this._gltfScene(MODEL_DIR + 'weapons/smg.glb')],
      ['zombieModel', () => this._fbx(MODEL_DIR + 'zombie.fbx')],
      ['animIdle', () => this._fbx(MODEL_DIR + 'anim/z_idle.fbx')],
      ['animWalk', () => this._fbx(MODEL_DIR + 'anim/z_walk.fbx')],
      ['animRun', () => this._fbx(MODEL_DIR + 'anim/z_run.fbx')],
      ['animAttack', () => this._fbx(MODEL_DIR + 'anim/z_attack.fbx')],
      ['animDeath', () => this._fbx(MODEL_DIR + 'anim/z_death.fbx')],
      ['box1', () => this._fbx(MODEL_DIR + 'box_1.fbx')],
      ['box2', () => this._fbx(MODEL_DIR + 'box_2.fbx')],
      ['box3', () => this._fbx(MODEL_DIR + 'box_3.fbx')],
      ['box4', () => this._fbx(MODEL_DIR + 'box_4.fbx')],
      ['ak74Color', () => this._tex(TEX_DIR + 'ak74_color.webp')],
      ['armColor', () => this._tex(TEX_DIR + 'arm_color.webp')],
      ['zombieColor', () => this._tex(TEX_DIR + 'zombie.webp')],
    ];

    let done = 0;
    const total = tasks.length;
    const results = {};

    // 顺序加载：避免单线程静态服务器/浏览器连接数限制导致请求被中断
    for (const [key, fn] of tasks) {
      try {
        results[key] = await fn();
      } catch (err) {
        console.error('[AssetManager] 资源加载失败:', key, err);
        results[key] = null;
      }
      done += 1;
      if (onProgress) onProgress(Math.round((done / total) * 100));
    }

    this.assets = {
      weaponModel: results.weaponModel,
      // 4 个独立 GLB 武器模型（pistol/shotgun/sniper/smg）
      weapons: {
        pistol: results.weaponPistol,
        shotgun: results.weaponShotgun,
        sniper: results.weaponSniper,
        smg: results.weaponSmg,
      },
      zombieModel: results.zombieModel,
      anims: {
        idle: stripRootMotion(pickClip(results.animIdle)),
        walk: stripRootMotion(pickClip(results.animWalk)),
        run: stripRootMotion(pickClip(results.animRun)),
        attack: stripRootMotion(pickClip(results.animAttack)),
        death: stripRootMotion(pickClip(results.animDeath)),
      },
      boxes: [results.box1, results.box2, results.box3, results.box4].filter(Boolean),
      textures: {
        ak74: results.ak74Color,
        arm: results.armColor,
        zombie: results.zombieColor,
      },
    };
    return this.assets;
  }
}

/** 从 FBX 结果中取出第一条动画 */
function pickClip(fbx) {
  if (!fbx || !fbx.animations || fbx.animations.length === 0) return null;
  return fbx.animations[0];
}

// 根骨骼 / 根对象名称：这些节点的位移会把整个模型拖走
const ROOT_NODES = /^(Zombie|Base_HumanPelvis)$/i;

/**
 * 去除动画里烘焙的根位移（root motion）
 *
 * 丧尸 FBX 的 walk / run / death 在根骨骼上带了位移（run 一圈能漂出几米），
 * 而游戏里的位移完全由 AI 逻辑驱动，两者叠加就会表现为：
 *  - 追击时模型"影子一样"窜出去几米 → 切动画的瞬间又弹回原处（看起来像闪烁）
 *  - 影子投影跟着模型一起乱飞
 * 这里把根骨骼位置轨道里的 XZ 固定到首帧（保留 Y，死亡倒地的下沉仍然有效）。
 */
function stripRootMotion(clip) {
  if (!clip) return null;
  let changed = false;
  const tracks = clip.tracks.map((track) => {
    if (!track.name.endsWith('.position')) return track;
    const node = track.name.slice(0, -'.position'.length);
    if (!ROOT_NODES.test(node)) return track;
    const values = new Float32Array(track.values);
    const x0 = values[0];
    const z0 = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = x0;
      values[i + 2] = z0;
    }
    track.values = values;
    changed = true;
    return track;
  });
  return changed ? new THREE.AnimationClip(clip.name, clip.duration, tracks) : clip;
}
