/**
 * 模式配置 / 存档 单测（node --test）
 * modes.js 与 SaveManager 都是纯逻辑，不碰 DOM、不碰 Three。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { endlessWave, ENDLESS, BALANCE, DEFENSE, DEFENSE_WAVES, defenseWave, isDefenseMode } from '../src/config/modes.js';
import { SaveManager, SAVE_KEY, defaultSave, SAVE_VERSION } from '../src/core/SaveManager.js';
import { DEFAULT_BINDS, normalizeBinds, formatBind } from '../src/config/keybinds.js';
import { RUN_REWARDS } from '../src/config/economy.js';
import { AMMO_SHOP, MATERIAL_SHOP, MOD_UNLOCK } from '../src/config/progression.js';

/** 按配置计算单局声望，避免平衡调整后测试写死过期数值 */
const repOf = (kills, waves, win) => Math.floor(kills / RUN_REWARDS.repPerKillDiv)
  + Math.floor(waves / RUN_REWARDS.repPerWaveDiv)
  + (win ? RUN_REWARDS.repWin : RUN_REWARDS.repLose);

class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const sumMix = (mix) => Object.values(mix).reduce((a, b) => a + b, 0);

test('无尽模式：第 1 波基础数量正确', () => {
  const w = endlessWave(1);
  assert.equal(w.total, ENDLESS.baseTotal);
  assert.equal(w.alive, ENDLESS.baseAlive);
  assert.equal(w.healthMul, 1);
  assert.equal(w.mix.walker + w.mix.swift, w.total);
});

test('无尽模式：变体配额总数等于 total（首领额外不计入）', () => {
  for (const n of [2, 5, 9, 11, 20]) {
    const w = endlessWave(n);
    const boss = w.mix.boss || 0;
    assert.equal(sumMix(w.mix) - boss, w.total, `第 ${n} 波配额不等于 total`);
  }
});

test('无尽模式：数量与血量持续攀升，无波数上限', () => {
  const w999 = endlessWave(999);
  const w1000 = endlessWave(1000);
  // 数量不再触顶：每波 +2，不再卡在 maxTotal
  assert.equal(w999.total, ENDLESS.baseTotal + ENDLESS.totalStep * (999 - 1));
  assert.equal(w1000.total, w999.total + ENDLESS.totalStep);
  // 血量不再触顶：每波复利攀升，不再卡在 healthCap
  assert.ok(w999.healthMul > ENDLESS.healthCap);
  assert.ok(w1000.healthMul > w999.healthMul);
});

test('无尽模式：按 ENDLESS.bossEvery 出现首领，其余波次没有', () => {
  const n = ENDLESS.bossEvery;
  assert.equal(endlessWave(n).mix.boss, 1);
  assert.equal(endlessWave(n * 2).mix.boss, 1);
  assert.equal(endlessWave(n - 1).mix.boss, undefined);
});

test('平衡上限：所有成长维度均无上限（Infinity）', () => {
  assert.equal(BALANCE.maxDamageBonus, Infinity);
  assert.equal(BALANCE.maxSpeedBonus, Infinity);
  assert.equal(BALANCE.maxHealthBonus, Infinity);
  assert.equal(BALANCE.maxArmorBonus, Infinity);
});

test('守城模式：十轮波次表长度与数量递增', () => {
  assert.equal(DEFENSE_WAVES.length, DEFENSE.waves);
  assert.equal(DEFENSE_WAVES[0].total, DEFENSE.baseTotal);
  assert.ok(DEFENSE_WAVES[9].total > DEFENSE_WAVES[0].total);
  assert.ok(DEFENSE_WAVES.every((w) => w.alive <= DEFENSE.maxAlive));
});

test('守城模式：每 5 波出现首领，配额总数等于 total', () => {
  assert.equal(defenseWave(5).mix.boss, 1);
  assert.equal(defenseWave(10).mix.boss, 1);
  assert.equal(defenseWave(4).mix.boss, undefined);
  for (const n of [1, 3, 5, 10]) {
    const w = defenseWave(n);
    const boss = w.mix.boss || 0;
    assert.equal(sumMix(w.mix) - boss, w.total);
  }
});

test('守城模式：识别两种守城模式', () => {
  assert.equal(isDefenseMode('defense'), true);
  assert.equal(isDefenseMode('defense_endless'), true);
  assert.equal(isDefenseMode('endless'), false);
  assert.equal(isDefenseMode('campaign'), false);
});

test('存档：首次读取返回默认值', () => {
  const s = new SaveManager(new MemStorage());
  assert.equal(s.data.stats.runs, 0);
  assert.equal(s.data.meta.cores, 0);
  assert.equal(s.data.unlocks.levels, 1);
  assert.deepEqual(s.data.unlocks.weapons.length > 0, true);
});

test('存档：写入后可重新读出', () => {
  const storage = new MemStorage();
  const a = new SaveManager(storage);
  a.addCores(3);
  const b = new SaveManager(storage);
  assert.equal(b.data.meta.cores, 3);
});

test('存档：损坏 JSON / 旧版本号回退到默认值', () => {
  const storage = new MemStorage();
  storage.setItem(SAVE_KEY, '{oops');
  const a = new SaveManager(storage);
  assert.equal(a.data.stats.runs, 0);

  storage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION - 1, stats: { runs: 99 } }));
  const b = new SaveManager(storage);
  assert.equal(b.data.stats.runs, 0);
});

test('存档：结算累计战绩并推进关卡解锁', () => {
  const s = new SaveManager(new MemStorage());
  s.recordRun({ kills: 12, seconds: 90, level: 1, wave: 3, win: true });
  assert.equal(s.data.stats.runs, 1);
  assert.equal(s.data.stats.kills, 12);
  assert.equal(s.data.stats.totalTime, 90);
  assert.equal(s.data.stats.bestLevel, 1);
  assert.equal(s.data.stats.bestWave, 3);
  assert.equal(s.data.unlocks.levels, 2);
});

test('存档：reset 恢复默认值', () => {
  const storage = new MemStorage();
  const s = new SaveManager(storage);
  s.recordRun({ kills: 5, seconds: 30, level: 2, win: true });
  s.reset();
  assert.deepEqual(s.data, defaultSave());
});

test('默认键位：与需求清单一致', () => {
  assert.equal(DEFAULT_BINDS.crouch, 'KeyC');
  assert.equal(DEFAULT_BINDS.sprint, 'ShiftLeft');
  assert.equal(DEFAULT_BINDS.fire, 'Mouse0');
  assert.equal(DEFAULT_BINDS.aim, 'Mouse2');
  assert.equal(DEFAULT_BINDS.ammoWheel, 'ControlLeft+KeyR');
  assert.equal(DEFAULT_BINDS.panel, 'Tab');
  assert.equal(DEFAULT_BINDS.map, 'Backquote');
  assert.equal(DEFAULT_BINDS.backpack, 'KeyB');
  assert.equal(DEFAULT_BINDS.pickup, 'KeyF');
  assert.equal(DEFAULT_BINDS.autoPickup, 'KeyP');
  assert.equal(DEFAULT_BINDS.pause, 'Escape');
  assert.deepEqual(
    ['skill1', 'skill2', 'skill3', 'skill4', 'skill5', 'skill6', 'skill7']
      .map((id) => DEFAULT_BINDS[id].slice(3)),
    ['Q', 'E', 'T', 'Y', 'U', 'I', 'O']
  );
});

test('键位：脏数据被过滤，缺失动作回落到默认值', () => {
  const binds = normalizeBinds({ crouch: 'KeyX', fire: 123, unknown: 'KeyZ' });
  assert.equal(binds.crouch, 'KeyX');
  assert.equal(binds.fire, DEFAULT_BINDS.fire);
  assert.equal(binds.unknown, undefined);
  assert.equal(binds.forward, DEFAULT_BINDS.forward);
});

test('键位：组合键显示名', () => {
  assert.equal(formatBind('KeyW'), 'W');
  assert.equal(formatBind('Digit2'), '2');
  assert.equal(formatBind('ControlLeft+KeyR'), 'Ctrl + R');
  assert.equal(formatBind('Mouse2'), '鼠标右键');
  assert.equal(formatBind(''), '未绑定');
});

test('存档：改键可持久化并支持恢复默认', () => {
  const storage = new MemStorage();
  const a = new SaveManager(storage);
  a.setBind('crouch', 'KeyX');
  assert.equal(a.data.settings.binds.crouch, 'KeyX');

  const b = new SaveManager(storage);
  assert.equal(b.data.settings.binds.crouch, 'KeyX');

  b.resetBinds();
  assert.equal(b.data.settings.binds.crouch, DEFAULT_BINDS.crouch);
});

test('经济：单局结算金币 / 声望 / 核心', () => {
  const s = new SaveManager(new MemStorage());
  const rw = s.recordRun({ kills: 12, seconds: 90, level: 1, wave: 3, win: true });
  assert.equal(rw.coins, 166);       // 12*3 + 3*10 + 100
  assert.equal(rw.reputation, repOf(12, 3, true));
  assert.equal(rw.cores, 2);
  assert.equal(s.data.meta.coins, 166);
  assert.equal(s.data.meta.reputation, repOf(12, 3, true));
  assert.equal(s.data.meta.cores, 2);
});

test('经济：失败结算仍给保底金币与声望', () => {
  const s = new SaveManager(new MemStorage());
  const rw = s.recordRun({ kills: 0, seconds: 20, level: 1, wave: 0, win: false });
  assert.equal(rw.coins, 15);
  assert.equal(rw.reputation, repOf(0, 0, false));
  assert.equal(rw.cores, 0);
});

test('任务：完成后可领取一次，奖励写入存档', () => {
  const storage = new MemStorage();
  const s = new SaveManager(storage);
  assert.equal(s.getMissionStates()[0].progress, 0);
  assert.equal(s.claimMission('first_run'), null);   // 未完成不可领

  s.recordRun({ kills: 5, seconds: 40, level: 1, win: true });
  const granted = s.claimMission('first_run');
  assert.equal(granted.coins, 120);
  assert.equal(granted.reputation, 2);
  assert.equal(s.data.meta.coins, 115 + 120);        // 5*3 + 100 + 120
  assert.equal(s.claimMission('first_run'), null);   // 已领取

  const b = new SaveManager(storage);
  assert.equal(b.getMissionStates()[0].claimed, true);
});

test('任务：材料奖励写入对应材料池', () => {
  const s = new SaveManager(new MemStorage());
  s.recordRun({ kills: 0, seconds: 300, level: null, wave: 10, win: true });
  const before = s.data.meta.materials.awaken;
  const granted = s.claimMission('hold_10');
  assert.equal(granted.materials.awaken, 1);
  assert.equal(s.data.meta.materials.awaken, before + 1);
});

test('经济：消费余额不足时不扣款', () => {
  const s = new SaveManager(new MemStorage());
  assert.equal(s.spend({ coins: 300, reputation: 5 }), false);
  s._grantReward({ coins: 300, reputation: 5 });
  assert.equal(s.spend({ coins: 300, reputation: 5 }), true);
  assert.equal(s.data.meta.coins, 0);
  assert.equal(s.data.meta.reputation, 0);
});

test('弹药：局外采购按口径计价并受库存上限约束', () => {
  const s = new SaveManager(new MemStorage());
  const def = AMMO_SHOP.rifle;
  s.data.meta.coins = 1000;
  const before = s.data.meta.ammoStock.rifle;
  const res = s.buyAmmo('rifle');
  assert.equal(res.ok, true);
  assert.equal(s.data.meta.coins, 1000 - def.price);
  assert.equal(s.data.meta.ammoStock.rifle, before + def.rounds);

  s.data.meta.ammoStock.rifle = def.cap;
  const full = s.buyAmmo('rifle');
  assert.equal(full.ok, false);
  assert.equal(s.data.meta.ammoStock.rifle, def.cap);
});

test('材料：采购价格随购买次数递增，余额不足不扣款', () => {
  const s = new SaveManager(new MemStorage());
  s.data.meta.coins = 2000;
  s.data.meta.reputation = 50;
  s.data.progress.level = 5;
  const def = MATERIAL_SHOP.awaken;
  const p1 = s.materialShopPrice('awaken');
  assert.equal(s.buyMaterial('awaken').ok, true);
  const p2 = s.materialShopPrice('awaken');
  assert.equal(p2, p1 + def.priceStep);
  assert.equal(s.materialCount('awaken'), 1);

  s.data.meta.coins = 0;
  const fail = s.buyMaterial('awaken');
  assert.equal(fail.ok, false);
  assert.equal(s.materialCount('awaken'), 1);
});

test('货币：买卖差价与门槛', () => {
  const s = new SaveManager(new MemStorage());
  s.data.progress.level = 2;
  s.data.meta.reputation = 20;
  s.data.meta.cores = 1;
  s.data.meta.coins = 0;
  assert.equal(s.exchange('sellCoreCoins').ok, true);
  assert.equal(s.data.meta.cores, 0);
  assert.equal(s.data.meta.coins, 10000);

  s.data.meta.coins = 50000;
  assert.equal(s.exchange('buyCoreCoins').ok, true);
  assert.equal(s.data.meta.cores, 1);
  assert.equal(s.data.meta.coins, 0);
});

test('改装：槽位金币解锁 + 普通配件制造 + 元素配件门槛', () => {
  const s = new SaveManager(new MemStorage());
  s.data.meta.coins = 5000;
  assert.equal(s.isModSlotUnlocked('optic'), false);
  assert.equal(s.unlockModSlot('optic').ok, true);
  assert.equal(s.isModSlotUnlocked('optic'), true);
  assert.equal(s.data.meta.coins, 5000 - MOD_UNLOCK.slots.optic);

  assert.equal(s.craftAttachment('optic', 'reddot').ok, true);
  assert.equal(s.isAttachmentCrafted('reddot'), true);

  s.data.meta.materials.bossCore = 0;
  s.data.meta.reputation = 0;
  assert.equal(s.craftAttachment('muzzle', 'muzzle_fire').ok, false);   // 槽位未解锁
  assert.equal(s.unlockModSlot('muzzle').ok, true);
  const noRep = s.craftAttachment('muzzle', 'muzzle_fire');
  assert.equal(noRep.ok, false);
  assert.equal(s.isAttachmentCrafted('muzzle_fire'), false);
});

test('科研：门槛满足后升级并消耗科研材料', () => {
  const s = new SaveManager(new MemStorage());
  s.data.meta.reputation = 0;
  s.data.progress.level = 1;
  assert.equal(s.upgradeResearch('ballistics').ok, false);

  s.data.meta.reputation = 60;
  s.data.progress.level = 10;
  s.data.permanent.dmg = 5;
  s.data.meta.coins = 1000;
  s.data.meta.materials.researchAmmo = 3;
  const res = s.upgradeResearch('ballistics');
  assert.equal(res.ok, true);
  assert.equal(s.researchLevel('ballistics'), 1);
  assert.equal(s.data.meta.materials.researchAmmo, 2);
  assert.equal(s.data.meta.coins, 800);
});

test('存档：旧版单一 research 材料迁移为研究数据', () => {
  const storage = new MemStorage();
  const legacy = defaultSave();
  legacy.meta.materials = { awaken: 1, mecha: 2, research: 5 };
  storage.setItem(SAVE_KEY, JSON.stringify(legacy));
  const s = new SaveManager(storage);
  assert.equal(s.materialCount('awaken'), 1);
  assert.equal(s.materialCount('mecha'), 2);
  assert.equal(s.materialCount('researchAmmo'), 5);
});
