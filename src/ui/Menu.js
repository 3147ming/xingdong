/**
 * 菜单 / 加载 / 暂停 / 结算界面控制
 * 只做 DOM 显隐与数值填充，不含任何游戏逻辑。
 */
import { LobbyUI } from './LobbyUI.js';

export class Menu {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.lobby = new LobbyUI();
    this.loading = document.getElementById('loading');
    this.loadingFill = document.getElementById('loading-fill');
    this.loadingText = document.getElementById('loading-text');
    this.menu = document.getElementById('menu');
    this.pause = document.getElementById('pause');
    this.result = document.getElementById('result');

    // 结算面板字段
    this.resultKicker = document.getElementById('result-kicker');
    this.resultTitle = document.getElementById('result-title');
    this.resultGrade = document.getElementById('result-grade');
    this.resultScore = document.getElementById('result-score');
    this.resultRewards = document.getElementById('result-rewards');
    this.rs = {
      kills: document.getElementById('rs-kills'),
      heads: document.getElementById('rs-heads'),
      acc: document.getElementById('rs-acc'),
      time: document.getElementById('rs-time'),
      dmg: document.getElementById('rs-dmg'),
      wave: document.getElementById('rs-wave'),
    };

    document.getElementById('btn-start').addEventListener('click', () => {
      this.callbacks.onStart && this.callbacks.onStart();
    });
    document.getElementById('btn-resume').addEventListener('click', () => {
      this.callbacks.onResume && this.callbacks.onResume();
    });
    const btnRestart = document.getElementById('btn-restart');
    if (btnRestart) {
      btnRestart.addEventListener('click', () => {
        this.callbacks.onRestart && this.callbacks.onRestart();
      });
    }
    const btnAgain = document.getElementById('btn-again');
    if (btnAgain) {
      btnAgain.addEventListener('click', () => {
        this.callbacks.onRestart && this.callbacks.onRestart();
      });
    }
    const btnMenu = document.getElementById('btn-menu');
    if (btnMenu) {
      btnMenu.addEventListener('click', () => {
        this.callbacks.onMenu && this.callbacks.onMenu();
      });
    }
    // 暂停面板：退出到大厅（与结算面板的返回主菜单共用同一回调）
    const btnExit = document.getElementById('btn-exit-lobby');
    if (btnExit) {
      btnExit.addEventListener('click', () => {
        this.callbacks.onMenu && this.callbacks.onMenu();
      });
    }
    // 大厅面板：关闭后回到 3D 漫游
    const btnCloseLobby = document.getElementById('btn-close-lobby');
    if (btnCloseLobby) {
      btnCloseLobby.addEventListener('click', () => {
        this.callbacks.onCloseLobby && this.callbacks.onCloseLobby();
      });
    }
  }

  setLoading(percent, text) {
    this.loadingFill.style.width = percent + '%';
    this.loadingText.textContent = text || `正在加载资源 ${percent}%`;
  }

  hideLoading() {
    this.loading.classList.add('hidden');
  }

  /** 加载完成：关闭加载界面，进入 3D 大厅（面板默认隐藏，可自由漫游） */
  showStart() {
    this.hideLoading();
    this.hideAll();
    if (this.lobby) this.lobby.resetTab();
  }

  /** 打开大厅面板并切到指定页签（由 3D 设施交互 / TAB 触发） */
  showLobbyPanel(tab) {
    this.hideLoading();
    this.pause.classList.add('hidden');
    if (this.result) this.result.classList.add('hidden');
    this.menu.classList.remove('hidden');
    if (this.lobby) this.lobby.showTab(tab || 'battle');
  }

  /** 关闭大厅面板，交还 3D 漫游 */
  hideLobbyPanel() {
    this.menu.classList.add('hidden');
  }

  get lobbyPanelVisible() {
    return !this.menu.classList.contains('hidden');
  }

  showPause() {
    this.menu.classList.add('hidden');
    this.pause.classList.remove('hidden');
    if (this.result) this.result.classList.add('hidden');
  }

  /**
   * 结算面板
   * @param {{win:boolean, score:number, grade:string, kills:number, headshots:number,
   *          accuracy:number, seconds:number, damageTaken:number,
   *          wavesCleared:number, waveTotal:number, totalEnemies:number}} r
   */
  showResult(r) {
    if (!this.result) return;
    this.result.classList.toggle('win', !!r.win);
    this.result.classList.toggle('lose', !r.win);
    this.resultKicker.textContent = r.kicker || (r.win ? 'MISSION COMPLETE' : 'MISSION FAILED');
    this.resultTitle.textContent = r.title || (r.win ? '区域肃清' : '行动阵亡');
    this.resultGrade.textContent = r.grade;
    this.resultGrade.dataset.grade = r.grade;
    this.resultScore.textContent = String(r.score);
    if (this.resultRewards) {
      const rw = r.rewards;
      if (rw) {
        const parts = [`金币 +${rw.coins}`, `声望 +${rw.reputation}`];
        if (rw.cores) parts.push(`核心 +${rw.cores}`);
        if (rw.xp) parts.push(`经验 +${rw.xp}`);
        if (rw.levelUp) parts.push(`属性点 +${rw.levelUp}`);
        this.resultRewards.textContent = `本局结算：${parts.join(' · ')}`;
      } else {
        this.resultRewards.textContent = '';
      }
    }

    if (this.rs.kills) this.rs.kills.textContent = String(r.kills);
    if (this.rs.heads) this.rs.heads.textContent = String(r.headshots);
    if (this.rs.acc) this.rs.acc.textContent = Math.round(r.accuracy * 100) + '%';
    if (this.rs.time) {
      const m = Math.floor(r.seconds / 60);
      const s = Math.floor(r.seconds % 60);
      this.rs.time.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
    if (this.rs.dmg) this.rs.dmg.textContent = String(r.damageTaken);
    if (this.rs.wave) {
      this.rs.wave.textContent = r.infinite
        ? `${r.wavesCleared} 波`
        : `${r.wavesCleared}/${r.waveTotal}`;
    }

    // 标题下方的小字：胜利说明战果，失败说明差多少
    this.resultKicker.title = r.infinite
      ? `无尽生存共坚守 ${r.wavesCleared} 波 · 歼灭 ${r.totalEnemies} 名敌人`
      : (r.win
        ? `共歼灭 ${r.totalEnemies} 名敌人`
        : `已肃清 ${r.wavesCleared}/${r.waveTotal} 波`);

    this.menu.classList.add('hidden');
    this.pause.classList.add('hidden');
    this.result.classList.remove('hidden');
  }

  hideAll() {
    this.menu.classList.add('hidden');
    this.pause.classList.add('hidden');
    if (this.result) this.result.classList.add('hidden');
  }

  get resultVisible() {
    return !!this.result && !this.result.classList.contains('hidden');
  }

  get pauseVisible() {
    return !this.pause.classList.contains('hidden');
  }
}
