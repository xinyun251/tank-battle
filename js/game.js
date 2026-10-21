/* ============================================================================
 * 坦克大战 · Tank Battle
 * 纯前端 Canvas 实现，零依赖。
 *
 * 结构：
 *   1. 常量与配置
 *   2. 工具函数
 *   3. 地图与地形
 *   4. 音效（WebAudio 合成）
 *   5. 实体：Base / Tank / Player / Enemy / Bullet / PowerUp / Explosion
 *   6. 关卡数据
 *   7. 游戏主循环与状态机
 *   8. 输入（键盘 / 触屏）
 *   9. 渲染与 HUD
 * ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 常量与配置
   * ------------------------------------------------------------------ */

  const COLS = 13;
  const ROWS = 13;
  const TILE = 32;
  const W = COLS * TILE;          // 416
  const H = ROWS * TILE;          // 416
  const MAX_BULLETS = 40;

  const DIRS = {
    up:    { x: 0,  y: -1 },
    down:  { x: 0,  y: 1 },
    left:  { x: -1, y: 0 },
    right: { x: 1,  y: 0 },
  };
  const DIR_LIST = ['up', 'right', 'down', 'left'];

  // 地形类型
  const T = { EMPTY: 0, BRICK: 1, STEEL: 2, WATER: 3, TREES: 4 };

  const TANK_SIZE = 28;
  const BULLET_SIZE = 6;

  // 玩家子弹最多同时存在数
  const PLAYER_BULLET_LIMIT = 1;

  // 敌方坦克行进时的「吸附」容差：小于此值会被对齐到网格
  const SNAP_TOLERANCE = 8;

  const POWER_UP_TYPES = ['star', 'grenade', 'helmet', 'shovel', 'tank', 'clock'];
  const POWER_UP_LIFE = 12000;

  const DIFFICULTY = {
    easy:   { label: '简单', spawnMs: 2600, maxAlive: 3, speed: 0.80, fireMs: [1400, 2600], smartSeek: false },
    normal: { label: '普通', spawnMs: 1900, maxAlive: 4, speed: 1.00, fireMs: [900, 1900],  smartSeek: true  },
    hard:   { label: '困难', spawnMs: 1350, maxAlive: 5, speed: 1.18, fireMs: [600, 1300],  smartSeek: true  },
  };

  const PLAYER_SPEED = 1.85;
  const PLAYER_FIRE_MS = 320;
  const PLAYER_SPAWN_MS = 1400;   // 出生无敌时间

  /* ------------------------------------------------------------------ *
   * 2. 工具函数
   * ------------------------------------------------------------------ */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const chance = (p) => Math.random() < p;
  const tileCenter = (t) => t * TILE + TILE / 2;

  /** 轴对齐包围盒相交 */
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /** 圆形爆炸是否与矩形相交 */
  function circleHitsRect(cx, cy, r, rect) {
    const nx = clamp(cx, rect.x, rect.x + rect.w);
    const ny = clamp(cy, rect.y, rect.y + rect.h);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy <= r * r;
  }

  /* ------------------------------------------------------------------ *
   * 3. 地形
   * ------------------------------------------------------------------ */

  const terrain = new Uint8Array(COLS * ROWS);

  const idx = (c, r) => r * COLS + c;

  function getTile(c, r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return T.STEEL; // 边界视为墙
    return terrain[idx(c, r)];
  }
  const setTile = (c, r, v) => {
    if (c >= 0 && r >= 0 && c < COLS && r < ROWS) terrain[idx(c, r)] = v;
  };

  /** 坦克可通行？水与钢不可，砖可 */
  const isBlockingTile = (v) => v === T.BRICK || v === T.STEEL || v === T.WATER;

  /** 某矩形是否与不可通行的地形重叠（忽略树） */
  function rectHitsTerrain(x, y, w, h) {
    const c0 = Math.floor(x / TILE);
    const c1 = Math.floor((x + w - 1) / TILE);
    const r0 = Math.floor(y / TILE);
    const r1 = Math.floor((y + h - 1) / TILE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (isBlockingTile(getTile(c, r))) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 4. 音效（WebAudio 实时合成，无需素材文件）
   * ------------------------------------------------------------------ */

  const Sound = {
    ctx: null,
    enabled: true,
    master: null,

    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
    },

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    /** 通用音色：type 波形，freq 起始频率，dur 时长，vol 音量，slideTo 终止频率 */
    beep(type, freq, dur, vol = 0.6, slideTo = null) {
      if (!this.enabled || !this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    /** 白噪声爆炸 */
    noise(dur, vol = 0.5, filterFreq = 900, type = 'lowpass') {
      if (!this.enabled || !this.ctx) return;
      const t = this.ctx.currentTime;
      const len = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const flt = this.ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.setValueAtTime(filterFreq, t);
      flt.frequency.exponentialRampToValueAtTime(Math.max(60, filterFreq * 0.25), t + dur);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt).connect(gain).connect(this.master);
      src.start(t);
    },

    battle() {
      this.beep('square', 620, 0.07, 0.3, 200);
    },
    enemyShoot() { this.beep('square', 380, 0.07, 0.16, 150); },
    hitBrick()   { this.noise(0.07, 0.30, 1600, 'bandpass'); },
    hitSteel()   { this.beep('square', 240, 0.05, 0.18, 90); },
    explode()    { this.noise(0.34, 0.62, 1100); },
    bigExplode() { this.noise(0.72, 0.85, 700); this.beep('sawtooth', 120, 0.5, 0.35, 35); },
    powerUp()    { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep('triangle', f, 0.11, 0.35), i * 70)); },
    stageStart() { [392, 523, 659, 784].forEach((f, i) => setTimeout(() => this.beep('square', f, 0.14, 0.3), i * 110)); },
    gameOver()   { [392, 330, 262, 196].forEach((f, i) => setTimeout(() => this.beep('sawtooth', f, 0.3, 0.35), i * 180)); },
    win()        { [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => this.beep('square', f, 0.18, 0.32), i * 140)); },
    life()       { this.beep('triangle', 880, 0.1, 0.3, 1320); },
  };

  /* ------------------------------------------------------------------ *
   * 5. 实体
   * ------------------------------------------------------------------ */

  class Explosion {
    constructor(x, y, size = 20, big = false) {
      this.x = x;
      this.y = y;
      this.size = size;
      this.big = big;
      this.t = 0;
      this.dur = big ? 620 : 300;
      this.parts = [];
      const count = big ? 14 : 7;
      for (let i = 0; i < count; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(0.6, big ? 3.2 : 2.0);
        this.parts.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          r: rand(2, big ? 6 : 4),
          life: rand(0.5, 1),
        });
      }
    }

    update(dt) {
      this.t += dt;
      for (const p of this.parts) {
        p.x += p.vx * dt * 0.06;
        p.y += p.vy * dt * 0.06;
        p.vx *= 0.96;
        p.vy *= 0.96;
      }
      return this.t < this.dur;
    }

    draw(ctx) {
      const prog = this.t / this.dur;
      const alpha = 1 - prog;
      ctx.save();
      ctx.globalAlpha = alpha;
      // 核心闪光
      const r = this.size * (0.5 + prog * 0.9);
      const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r);
      g.addColorStop(0, this.big ? '#fff8c9' : '#ffffff');
      g.addColorStop(0.35, this.big ? '#ffb03a' : '#ffd166');
      g.addColorStop(1, 'rgba(255, 80, 20, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.fill();
      // 碎屑
      for (const p of this.parts) {
        ctx.globalAlpha = alpha * p.life;
        ctx.fillStyle = prog < 0.4 ? '#fff3b0' : '#ff7a3d';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 - prog * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  class Bullet {
    constructor(owner, x, y, dir, speed, power = 1) {
      this.owner = owner;             // 'player' | 'enemy'
      this.dir = dir;
      this.speed = speed;
      this.power = power;             // 1=普通 2=强化（可破钢）
      this.dead = false;
      this.w = BULLET_SIZE;
      this.h = BULLET_SIZE;
      // 以中心定位
      this.x = x - BULLET_SIZE / 2;
      this.y = y - BULLET_SIZE / 2;
    }

    get cx() { return this.x + this.w / 2; }
    get cy() { return this.y + this.h / 2; }

    update(dt) {
      const d = DIRS[this.dir];
      const step = this.speed * dt * 0.06;
      // 分步推进，避免高速穿墙
      const steps = Math.ceil(step / 3) || 1;
      for (let i = 0; i < steps; i++) {
        this.x += (d.x * step) / steps;
        this.y += (d.y * step) / steps;
        if (game.bulletCollide(this)) return;
      }
    }

    draw(ctx) {
      const cx = this.cx;
      const cy = this.cy;
      ctx.save();
      // 拖尾
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = this.owner === 'player' ? '#ffe08a' : '#ff9d6b';
      const d = DIRS[this.dir];
      ctx.beginPath();
      ctx.arc(cx - d.x * 6, cy - d.y * 6, 3, 0, Math.PI * 2);
      ctx.fill();
      // 弹头
      ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 5);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, this.power > 1 ? '#ff8ad8' : '#ffd24a');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fffdf0';
      ctx.fillRect(cx - 2, cy - 2, 4, 4);
      ctx.restore();
    }
  }

  class PowerUp {
    constructor(x, y, type) {
      this.x = x;
      this.y = y;
      this.type = type;
      this.w = 26;
      this.h = 26;
      this.life = POWER_UP_LIFE;
      this.t = 0;
      this.dead = false;
    }

    update(dt) {
      this.t += dt;
      this.life -= dt;
      if (this.life <= 0) this.dead = true;
    }

    draw(ctx) {
      const blink = this.life < 3000 && Math.floor(this.t / 130) % 2 === 0;
      if (blink) return;
      const { x, y, w, h } = this;
      ctx.save();
      const pulse = 1 + Math.sin(this.t / 160) * 0.06;
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(pulse, pulse);
      ctx.translate(-w / 2, -h / 2);

      ctx.fillStyle = 'rgba(10,14,20,.85)';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#f5c542';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, w - 2, h - 2);

      ctx.fillStyle = '#f5c542';
      ctx.font = 'bold 15px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const icon = {
        star: '★', grenade: '✹', helmet: '◆', shovel: '▤', tank: '♥', clock: '⌛',
      }[this.type];
      ctx.fillText(icon, w / 2, h / 2 + 1);
      ctx.restore();
    }
  }

  /** 坦克基类 */
  class Tank {
    constructor(x, y, dir = 'up') {
      this.w = TANK_SIZE;
      this.h = TANK_SIZE;
      this.x = x;
      this.y = y;
      this.dir = dir;
      this.speed = 1;
      this.dead = false;
      this.moving = false;
      this.muzzle = 0;          // 炮口火光剩余时间
      this.invuln = 0;
      this.hp = 1;
      this.t = 0;               // 自身计时器
    }

    get cx() { return this.x + this.w / 2; }
    get cy() { return this.y + this.h / 2; }

    /** 尝试移动，返回是否真的移动了 */
    move(dt, dir) {
      const d = DIRS[dir];
      if (this.dir !== dir) {
        this.dir = dir;
        this.snap();
      }
      const step = this.speed * dt * 0.06;
      const nx = this.x + d.x * step;
      const ny = this.y + d.y * step;
      if (game.canTankOccupy(this, nx, ny)) {
        this.x = nx;
        this.y = ny;
        this.moving = true;
        return true;
      }
      this.moving = false;
      return false;
    }

    /** 转向时把垂直于运动方向的坐标吸附到半格，避免卡墙角 */
    snap() {
      const vert = this.dir === 'up' || this.dir === 'down';
      if (vert) {
        const c = Math.round((this.x - (TILE - TANK_SIZE) / 2) / TILE);
        const target = c * TILE + (TILE - TANK_SIZE) / 2;
        if (Math.abs(this.x - target) < SNAP_TOLERANCE && !rectHitsTerrain(target, this.y, this.w, this.h)) {
          this.x = target;
        }
      } else {
        const r = Math.round((this.y - (TILE - TANK_SIZE) / 2) / TILE);
        const target = r * TILE + (TILE - TANK_SIZE) / 2;
        if (Math.abs(this.y - target) < SNAP_TOLERANCE && !rectHitsTerrain(this.x, target, this.w, this.h)) {
          this.y = target;
        }
      }
    }

    fire(power = 1, speed = 4.4) {
      const d = DIRS[this.dir];
      const cx = this.cx + d.x * (TANK_SIZE / 2);
      const cy = this.cy + d.y * (TANK_SIZE / 2);
      game.bullets.push(new Bullet(this.owner, cx, cy, this.dir, speed, power));
      this.muzzle = 90;
      return true;
    }

    /** 每帧计时（伤害、炮口火光） */
    tick(dt) {
      this.t += dt;
      this.muzzle = Math.max(0, this.muzzle - dt * 0.2);
    }

    /** 绘制坦克（积木风格） */
    draw(ctx, palette) {
      const { x, y, w, h } = this;
      const vert = this.dir === 'up' || this.dir === 'down';
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);

      // 影
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(-w / 2 + 2, -h / 2 + 3, w, h);

      // 履带（两侧）
      ctx.fillStyle = palette.track;
      if (vert) {
        ctx.fillRect(-w / 2, -h / 2, 6, h);
        ctx.fillRect(w / 2 - 6, -h / 2, 6, h);
        // 履带纹理
        ctx.fillStyle = palette.trackLine;
        const offset = Math.floor(this.t / 60) % 6;
        for (let i = -h / 2 + offset; i < h / 2; i += 6) {
          ctx.fillRect(-w / 2, i, 6, 2);
          ctx.fillRect(w / 2 - 6, i, 6, 2);
        }
      } else {
        ctx.fillRect(-w / 2, -h / 2, w, 6);
        ctx.fillRect(-w / 2, h / 2 - 6, w, 6);
        ctx.fillStyle = palette.trackLine;
        const offset = Math.floor(this.t / 60) % 6;
        for (let i = -w / 2 + offset; i < w / 2; i += 6) {
          ctx.fillRect(i, -h / 2, 2, 6);
          ctx.fillRect(i, h / 2 - 6, 2, 6);
        }
      }

      // 车体
      ctx.fillStyle = palette.body;
      const bw = vert ? w - 12 : w - 6;
      const bh = vert ? h - 6 : h - 12;
      ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
      // 车体高光
      ctx.fillStyle = palette.highlight;
      ctx.fillRect(-bw / 2 + 2, -bh / 2 + 2, bw - 4, 2);

      // 炮塔
      ctx.fillStyle = palette.turret;
      ctx.beginPath();
      ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      ctx.fill();

      // 炮管
      ctx.save();
      ctx.rotate({ up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[this.dir]);
      ctx.fillStyle = palette.barrel;
      ctx.fillRect(-2, -h / 2 - 3, 4, h / 2 + 3);
      ctx.restore();

      // 炮口火光
      if (this.muzzle > 0) {
        ctx.save();
        ctx.rotate({ up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[this.dir]);
        ctx.globalAlpha = this.muzzle / 90;
        ctx.fillStyle = '#fff3b0';
        ctx.beginPath();
        ctx.arc(0, -h / 2 - 4, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 无敌护盾
      if (this.invuln > 0) {
        ctx.strokeStyle = `rgba(120, 220, 255, ${0.4 + Math.sin(this.t / 90) * 0.35})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, w / 2 + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  class Player extends Tank {
    constructor() {
      super(tileCenter(4) - TANK_SIZE / 2, tileCenter(12) - TANK_SIZE / 2, 'up');
      this.owner = 'player';
      this.speed = PLAYER_SPEED;
      this.level = 1;
      this.maxBullets = PLAYER_BULLET_LIMIT;
      this.fireCd = 0;
      this.shieldMs = PLAYER_SPAWN_MS;
      this.invuln = PLAYER_SPAWN_MS;
      this.spawning = PLAYER_SPAWN_MS;
    }

    update(dt, input) {
      this.tick(dt);
      if (this.fireCd > 0) this.fireCd -= dt;
      if (this.invuln > 0) this.invuln -= dt;
      if (this.spawning > 0) {
        this.spawning -= dt;
        return;
      }

      // 移动：以最后按下的方向为准
      const dir = input.lastDir();
      this.moving = false;
      if (dir) {
        // 十字键允许同时按两个时优先新按的
        this.move(dt, dir);
      }

      // 开火
      if (input.fire() && this.fireCd <= 0) {
        const alive = game.bullets.filter(b => b.owner === 'player' && !b.dead).length;
        if (alive < this.maxBullets) {
          this.fire(this.level >= 3 ? 2 : 1, this.level >= 2 ? 5.2 : 4.4);
          this.fireCd = PLAYER_FIRE_MS - (this.level >= 2 ? 80 : 0);
          Sound.battle();
        }
      }
    }

    /** 升级 */
    upgrade() {
      this.level = Math.min(4, this.level + 1);
      if (this.level >= 2) this.maxBullets = 2;
      if (this.level >= 4) this.invuln = Math.max(this.invuln, 1200);
    }

    get palette() {
      const p = [
        { body: '#e0a92a', highlight: '#ffe08a', turret: '#ffd75e', barrel: '#c98a12', track: '#8a6a12', trackLine: '#5f4a0c' },
        { body: '#e0a92a', highlight: '#ffe08a', turret: '#ffd75e', barrel: '#c98a12', track: '#8a6a12', trackLine: '#5f4a0c' },
        { body: '#efb733', highlight: '#fff0b0', turret: '#ffdd7a', barrel: '#d19616', track: '#94720f', trackLine: '#664f08' },
        { body: '#f6c944', highlight: '#fff6cf', turret: '#ffe89a', barrel: '#dba51e', track: '#9c7a11', trackLine: '#6d560a' },
      ][clamp(this.level - 1, 0, 3)];
      return p;
    }

    draw(ctx) {
      // 出生动画
      if (this.spawning > 0) {
        const p = 1 - this.spawning / PLAYER_SPAWN_MS;
        ctx.save();
        ctx.translate(this.cx, this.cy);
        ctx.strokeStyle = `rgba(245,197,66,${0.9 - p * 0.3})`;
        ctx.lineWidth = 3;
        const R = 20 * (1 - p) + 6;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + p * 3;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4);
          ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      super.draw(ctx, this.palette);
    }
  }

  class Enemy extends Tank {
    constructor(x, y, typeIndex, level) {
      super(x, y, 'down');
      this.owner = 'enemy';
      this.type = typeIndex;          // 0..3
      this.level = level;             // 关卡系数

      const spec = [
        { speed: 0.78, hp: 1, score: 100, reload: 1800, bulletSpeed: 3.6 },
        { speed: 1.05, hp: 1, score: 200, reload: 1500, bulletSpeed: 4.0 },
        { speed: 1.25, hp: 1, score: 300, reload: 1100, bulletSpeed: 4.6 },
        { speed: 0.72, hp: 3, score: 400, reload: 1600, bulletSpeed: 4.0 },
      ][typeIndex];

      const diff = DIFFICULTY[game.settings.difficulty];
      this.speed = spec.speed * diff.speed * (1 + (level - 1) * 0.04);
      this.hp = spec.hp + (level > 3 && typeIndex === 3 ? 1 : 0);
      this.maxHp = this.hp;
      this.score = spec.score;
      this.reloadBase = spec.reload * (level > 2 ? 0.85 : 1);
      this.bulletSpeed = spec.bulletSpeed;

      this.fireCd = rand(400, 1400);
      this.thinkCd = 0;
      this.dirHold = 0;
      this.carrier = false;           // 是否携带道具
    }

    get palette() {
      if (this.type === 3) {
        // 重甲：灰绿色
        return { body: '#8b9c6b', highlight: '#c3d49a', turret: '#d6e6b0', barrel: '#6b7a52', track: '#4d573b', trackLine: '#39412c' };
      }
      return [
        { body: '#c9ced6', highlight: '#f2f5f9', turret: '#eef2f7', barrel: '#9ba3ad', track: '#6c7480', trackLine: '#4d545e' },
        { body: '#b8c4d4', highlight: '#e6eef9', turret: '#dde8f6', barrel: '#8b98a8', track: '#616c7a', trackLine: '#454e59' },
        { body: '#d0b8c4', highlight: '#f7e6ee', turret: '#f2dbe6', barrel: '#a08b96', track: '#725f69', trackLine: '#52444c' },
      ][this.type];
    }

    update(dt) {
      this.tick(dt);
      if (this.fireCd > 0) this.fireCd -= dt;
      if (this.thinkCd > 0) this.thinkCd -= dt;
      if (this.dirHold > 0) this.dirHold -= dt;

      if (this.thinkCd <= 0 || (this.dirHold <= 0 && chance(0.02))) {
        this.aiThink();
      }

      // 若前方受阻，立即换向
      const d = DIRS[this.dir];
      const step = this.speed * dt * 0.06;
      if (!game.canTankOccupy(this, this.x + d.x * step, this.y + d.y * step)) {
        this.thinkCd = 0;
      }

      this.move(dt, this.dir);

      // 开火判断
      if (this.fireCd <= 0 && chance(0.5)) {
        if (this.shouldFire()) {
          const alive = game.bullets.filter(b => b.owner === 'enemy').length;
          if (alive < MAX_BULLETS * 0.5) {
            this.fire(1, this.bulletSpeed);
            this.fireCd = this.reloadBase * rand(0.75, 1.35);
            Sound.enemyShoot();
          }
        }
      }
    }

    /** 选择新方向 */
    aiThink() {
      const opts = [];
      const diff = DIFFICULTY[game.settings.difficulty];

      if (diff.smartSeek && chance(0.55)) {
        // 朝目标方向（玩家或基地）前进
        const target = (chance(0.65) && game.player && !game.player.spawning)
          ? game.player
          : { cx: game.baseX, cy: game.baseY };
        const dx = target.cx - this.cx;
        const dy = target.cy - this.cy;
        if (Math.abs(dx) > Math.abs(dy)) {
          opts.push(dx > 0 ? 'right' : 'left', dy > 0 ? 'down' : 'up');
        } else {
          opts.push(dy > 0 ? 'down' : 'up', dx > 0 ? 'right' : 'left');
        }
      } else {
        // 随机游走，偏好向下（向基地逼近）
        const pool = ['down', 'down', 'left', 'right', 'up'];
        opts.push(choice(pool), choice(pool));
      }

      for (const dir of opts) {
        if (this.canGo(dir)) {
          this.setDir(dir);
          return;
        }
      }
      // 都不行就随机探一格
      const shuffled = DIR_LIST.filter(d => d !== this.dir);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (const dir of shuffled) {
        if (this.canGo(dir)) {
          this.setDir(dir);
          return;
        }
      }
      this.setDir(OPPOSITE[this.dir]);
    }

    canGo(dir) {
      const d = DIRS[dir];
      // 用完整的坦克尺寸试探，确保转过去后可以正常通行
      return game.canTankOccupy(this, this.x + d.x * 4, this.y + d.y * 4);
    }

    setDir(dir) {
      this.dir = dir;
      this.snap();
      this.thinkCd = rand(500, 1400);
      this.dirHold = rand(800, 2400);
    }

    /** 判断是否该开火：前方朝向玩家/基地，或有一定概率盲射 */
    shouldFire() {
      const diff = DIFFICULTY[game.settings.difficulty];
      if (chance(0.18)) return true;             // 盲射

      const p = game.player;
      if (!p || p.spawning) return chance(0.3);

      const d = DIRS[this.dir];
      // 同一条轴上
      const onAxis =
        (d.x === 0 && Math.abs(p.cx - this.cx) < TILE * 0.8) ||
        (d.y === 0 && Math.abs(p.cy - this.cy) < TILE * 0.8);
      if (onAxis) {
        const inFront = d.x !== 0 ? (p.cx - this.cx) * d.x > 0 : (p.cy - this.cy) * d.y > 0;
        if (inFront) return true;
      }
      // 指向基地
      const bd = DIRS[this.dir];
      const onBaseAxis =
        (bd.x === 0 && Math.abs(game.baseX - this.cx) < TILE * 0.8) ||
        (bd.y === 0 && Math.abs(game.baseY - this.cy) < TILE * 0.8);
      if (onBaseAxis && diff.smartSeek) return chance(0.5);

      return chance(0.06);
    }

    draw(ctx) {
      super.draw(ctx, this.palette);
      // 重甲坦克血条 / 装甲标记
      if (this.type === 3 && this.hp < this.maxHp) {
        const w = this.w;
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(this.x, this.y - 5, w, 3);
        ctx.fillStyle = '#7de08a';
        ctx.fillRect(this.x, this.y - 5, w * (this.hp / this.maxHp), 3);
      }
      // 携带道具的闪烁标记
      if (this.carrier) {
        const on = Math.floor(this.t / 160) % 2 === 0;
        if (on) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,90,90,.9)';
          ctx.lineWidth = 2;
          ctx.strokeRect(this.x - 2, this.y - 2, this.w + 4, this.h + 4);
          ctx.restore();
        }
      }
    }
  }

  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  /* ------------------------------------------------------------------ *
   * 6. 关卡数据
   *    字符含义： . 空地  B 砖墙  S 钢墙  W 水  T 草丛
   * ------------------------------------------------------------------ */

  const STAGES = [
    [ // 1 — 训练场
      '.............',
      '..B.......B..',
      '..B..BBB..B..',
      '..B..B.B..B..',
      '.....B.B.....',
      'BB...B.B...BB',
      '.............',
      'BB...BBB...BB',
      '.....B.B.....',
      '..B..B.B..B..',
      '..B..BBB..B..',
      '..B.......B..',
      '.....B.B.....',
    ],
    [ // 2 — 河道
      '..S.......S..',
      '.............',
      '.BBB.BBB.BBB.',
      '.B.........B.',
      '.B.SS...SS.B.',
      '...SS.W.SS...',
      '.....WWW.....',
      '...SS.W.SS...',
      '.B.SS...SS.B.',
      '.B.........B.',
      '.BBB.BBB.BBB.',
      '.............',
      '..S.......S..',
    ],
    [ // 3 — 丛林
      '..T.......T..',
      '.TTT.BBB.TTT.',
      '..T..B.B..T..',
      '.....B.B.....',
      'BB...TTT...BB',
      '....TTTTT....',
      '.BB..T.T..BB.',
      '....TTTTT....',
      'BB...TTT...BB',
      '.....B.B.....',
      '..T..B.B..T..',
      '.TTT.BBB.TTT.',
      '..T.......T..',
    ],
    [ // 4 — 堡垒
      '..S.......S..',
      '.BSB.BBB.BSB.',
      '..B..B.B..B..',
      '.....B.B.....',
      'BBB.SS.SS.BBB',
      'B.....W.....B',
      'B..B.WWW.B..B',
      'B.....W.....B',
      'BBB.SS.SS.BBB',
      '.....B.B.....',
      '..B..B.B..B..',
      '.BSB.BBB.BSB.',
      '..S.......S..',
    ],
    [ // 5 — 终局
      'STT.......TTS',
      '.T.BBBBBBB.T.',
      '.T.B.....B.T.',
      '...B.SSS.B...',
      'BB.B.WWW.B.BB',
      '....W...W....',
      '.BB.W.S.W.BB.',
      '....W...W....',
      'BB.B.WWW.B.BB',
      '...B.SSS.B...',
      '.T.B.....B.T.',
      '.T.BBBBBBB.T.',
      'STT.......TTS',
    ],
  ];

  function loadStage(n) {
    const map = STAGES[(n - 1) % STAGES.length];
    // 防御：行宽不足 13 时右侧补空，超长则截断
    for (let r = 0; r < ROWS; r++) {
      const line = (map[r] || '');
      map[r] = line.length < COLS ? line + '.'.repeat(COLS - line.length) : line.slice(0, COLS);
    }
    terrain.fill(T.EMPTY);
    for (let r = 0; r < ROWS; r++) {
      const line = map[r] || '';
      for (let c = 0; c < COLS; c++) {
        const ch = line[c] || '.';
        const v = ch === 'B' ? T.BRICK
          : ch === 'S' ? T.STEEL
          : ch === 'W' ? T.WATER
          : ch === 'T' ? T.TREES
          : T.EMPTY;
        setTile(c, r, v);
      }
    }
    // 清空出生点与基地周围
    const clear = (c, r) => { setTile(c, r, T.EMPTY); setTile(c - 1, r, T.EMPTY); setTile(c + 1, r, T.EMPTY); };
    clear(4, 12);   // 玩家出生
    clear(0, 0);    // 敌出生点
    clear(6, 0);
    clear(12, 0);
    setTile(6, 12, T.EMPTY);
    setTile(5, 12, T.EMPTY);
    setTile(7, 12, T.EMPTY);
    // 最后一排其余位置清空，避免堵死玩家路线
    for (let c = 0; c < COLS; c++) setTile(c, 12, T.EMPTY);
  }

  /* ------------------------------------------------------------------ *
   * 7. 游戏主体
   * ------------------------------------------------------------------ */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // 高 DPI 适配：内部按设备像素比放大，逻辑坐标仍为 416x416
  function setupCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  const game = {
    state: 'menu',            // menu | playing | paused | stageclear | gameover | victory
    settings: { difficulty: 'normal', lives: 5, sound: true },

    player: null,
    enemies: [],
    bullets: [],
    powerups: [],
    explosions: [],

    stage: 1,
    lives: 5,
    score: 0,
    totalKills: 0,

    baseAlive: true,
    baseX: 0,
    baseY: 0,
    baseWallsTimer: 0,        // 铁锹效果剩余

    spawnTimer: 0,
    spawnPointIndex: 0,
    enemiesLeft: 0,           // 待出场 + 场上存活
    enemiesTotal: 0,
    carrierIndex: 0,

    clockTimer: 0,            // 时钟道具：冻结敌人
    shovelTimer: 0,

    bannerText: '',
    bannerTimer: 0,

    lastTime: 0,
    shake: 0,
    particles: [],

    /* ---------- 生命周期 ---------- */

    reset(full = true) {
      this.enemies = [];
      this.bullets = [];
      this.powerups = [];
      this.explosions = [];
      this.particles = [];
      if (full) {
        this.stage = 1;
        this.score = 0;
        this.totalKills = 0;
        this.lives = this.settings.lives;
      }
      this.startStage(this.stage);
    },

    startStage(n) {
      this.stage = n;
      loadStage(n);

      // 基地坐标
      this.baseX = tileCenter(6);
      this.baseY = tileCenter(12);
      this.baseAlive = true;
      this.baseWallsTimer = 0;
      this.shovelTimer = 0;
      this.clockTimer = 0;
      this.baseHitCount = 0;

      // 基地周围初始砖墙（老玩家熟悉的「三面护墙」）
      this.buildBaseWalls(T.BRICK);

      this.bullets.length = 0;
      this.powerups.length = 0;
      this.explosions.length = 0;
      this.enemies.length = 0;

      this.enemiesTotal = 12 + n * 4;
      this.enemiesLeft = this.enemiesTotal;
      this.carrierIndex = randInt(4, 8);
      this.spawnTimer = 600;
      this.spawnPointIndex = 0;

      this.player = new Player();
      this.setBanner(`第 ${n} 关`, 1400);
      Sound.stageStart();
      this.state = 'playing';
      hideMenu();
      hideOverlay();
      updateHUD();
    },

    setBanner(text, ms) {
      this.bannerText = text;
      this.bannerTimer = ms;
    },

    /* ---------- 碰撞 ---------- */

    canTankOccupy(tank, nx, ny, ignoreTanks = false) {
      if (nx < 0 || ny < 0 || nx + tank.w > W || ny + tank.h > H) return false;
      if (rectHitsTerrain(nx, ny, tank.w, tank.h)) return false;

      const box = { x: nx, y: ny, w: tank.w, h: tank.h };
      if (!ignoreTanks) {
        if (this.player && this.player !== tank && !this.player.spawning && aabb(box, this.player)) return false;
        for (const e of this.enemies) {
          if (e === tank || e.dead) continue;
          if (aabb(box, e)) return false;
        }
      }
      return true;
    },

    /** 子弹逐步推进时的碰撞检测（返回 true 表示子弹已消亡） */
    bulletCollide(b) {
      // 出界
      if (b.x < -4 || b.y < -4 || b.x + b.w > W + 4 || b.y + b.h > H + 4) {
        b.dead = true;
        this.addSparks(b.cx, b.cy, 4);
        return true;
      }

      // 地形
      const c0 = Math.floor(b.x / TILE);
      const c1 = Math.floor((b.x + b.w - 1) / TILE);
      const r0 = Math.floor(b.y / TILE);
      const r1 = Math.floor((b.y + b.h - 1) / TILE);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const t = getTile(c, r);
          if (t === T.BRICK || t === T.STEEL) {
            if (t === T.BRICK || b.power >= 2) {
              setTile(c, r, T.EMPTY);
              this.addSparks(tileCenter(c), tileCenter(r), 8, '#c86a3c');
              Sound.hitBrick();
              if (b.power >= 2) {
                // 强化弹顺带打掉相邻的砖
                const d = DIRS[b.dir];
                const nc = c + d.x, nr = r + d.y;
                if (getTile(nc, nr) === T.BRICK) setTile(nc, nr, T.EMPTY);
              }
            } else {
              Sound.hitSteel();
              this.addSparks(b.cx, b.cy, 5, '#cfd8e3');
            }
            b.dead = true;
            return true;
          }
        }
      }

      // 基地（护墙已被打掉时才会被击中）
      if (this.baseAlive) {
        const baseRect = { x: this.baseX - 13, y: this.baseY - 13, w: 26, h: 26 };
        if (aabb({ x: b.x, y: b.y, w: b.w, h: b.h }, baseRect)) {
          b.dead = true;
          // 第一次击中只是「打破护墙」，给玩家反应机会
          this.baseHitCount++;
          if (this.baseHitCount >= 2) {
            this.destroyBase();
          } else {
            this.addSparks(this.baseX, this.baseY, 12, '#f5c542');
            Sound.hitBrick();
            this.setBanner('基地受创！', 900);
            this.shake = 6;
          }
          return true;
        }
      }

      // 坦克
      if (b.owner === 'player') {
        for (const e of this.enemies) {
          if (e.dead) continue;
          if (aabb(b, e)) {
            b.dead = true;
            this.damageEnemy(e, b);
            return true;
          }
        }
      } else {
        const p = this.player;
        if (p && !p.spawning && aabb(b, p)) {
          if (p.invuln > 0) {
            b.dead = true;
            this.addSparks(b.cx, b.cy, 6, '#9be8ff');
            return true;
          }
          b.dead = true;
          this.killPlayer();
          return true;
        }
      }

      // 子弹互相抵消（玩家弹 vs 敌弹）
      for (const o of this.bullets) {
        if (o === b || o.dead) continue;
        if (o.owner === b.owner) continue;
        if (aabb(b, o)) {
          o.dead = true;
          b.dead = true;
          this.addSparks(b.cx, b.cy, 6, '#ffe08a');
          return true;
        }
      }

      return false;
    },

    addSparks(x, y, n = 5, color = '#ffd166') {
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(0.5, 2.4);
        this.particles.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 1,
          decay: rand(0.02, 0.06),
          color,
          r: rand(1, 2.4),
        });
      }
    },

    /* ---------- 战斗逻辑 ---------- */

    damageEnemy(e, bullet) {
      e.hp -= 1;
      if (e.hp > 0) {
        Sound.hitSteel();
        this.addSparks(bullet.cx, bullet.cy, 5, '#c3d49a');
        return;
      }
      e.dead = true;
      this.explosions.push(new Explosion(e.cx, e.cy, 24));
      Sound.explode();
      this.shake = Math.max(this.shake, 4);

      this.score += e.score;
      this.totalKills++;
      this.enemiesLeft--;

      // 掉落道具
      if (e.carrier) {
        this.dropPowerUp(e.cx, e.cy);
      }
      updateHUD();
      this.checkStageClear();
    },

    dropPowerUp(x, y) {
      const type = choice(POWER_UP_TYPES);
      this.powerups.push(new PowerUp(x - 13, y - 13, type));
    },

    killPlayer() {
      const p = this.player;
      if (!p || p.spawning) return;

      this.explosions.push(new Explosion(p.cx, p.cy, 28));
      Sound.explode();
      this.shake = 8;

      // 等级降低
      if (p.level > 1) p.level -= 1;
      p.spawning = PLAYER_SPAWN_MS;
      p.invuln = PLAYER_SPAWN_MS * 1.4;
      p.x = tileCenter(4) - TANK_SIZE / 2;
      p.y = tileCenter(12) - TANK_SIZE / 2;
      p.dir = 'up';
      p.maxBullets = p.level >= 2 ? 2 : 1;

      this.lives--;
      Sound.life();
      updateHUD();

      if (this.lives < 0) {
        this.gameOver(false);
      }
    },

    destroyBase() {
      if (!this.baseAlive) return;
      this.baseAlive = false;
      this.explosions.push(new Explosion(this.baseX, this.baseY, 46, true));
      Sound.bigExplode();
      this.shake = 14;
      setTimeout(() => {
        if (this.state === 'playing' || this.state === 'paused') this.gameOver(false);
      }, 700);
    },

    applyPowerUp(pu) {
      const p = this.player;
      Sound.powerUp();
      this.score += 500;
      let text = '';

      switch (pu.type) {
        case 'star':
          p.upgrade();
          text = '火力提升！';
          break;
        case 'grenade':
          // 消灭场上所有敌人
          for (const e of this.enemies) {
            if (e.dead) continue;
            e.dead = true;
            this.explosions.push(new Explosion(e.cx, e.cy, 22));
            this.score += e.score;
            this.totalKills++;
            this.enemiesLeft--;
          }
          Sound.bigExplode();
          this.shake = 10;
          text = '全屏爆破！';
          this.checkStageClear();
          break;
        case 'helmet':
          p.invuln = Math.max(p.invuln, 8000);
          text = '无敌护盾 8 秒';
          break;
        case 'shovel': {
          // 基地周围变钢墙 20 秒
          this.shovelTimer = 20000;
          this.buildBaseWalls(T.STEEL);
          text = '基地强化 20 秒';
          break;
        }
        case 'tank':
          this.lives++;
          text = '获得额外生命';
          break;
        case 'clock':
          this.clockTimer = 8000;
          text = '敌军冻结 8 秒';
          break;
      }

      this.setBanner(text, 1100);
      updateHUD();
    },

    buildBaseWalls(type) {
      // 基地左右两侧 + 上方一整排，形成「凹」字形护墙（下方是地图边界）
      const c = 6, r = 12;
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 0; dr++) {
          if (dr === 0 && dc === 0) continue;
          setTile(c + dc, r + dr, type);
        }
      }
    },

    checkStageClear() {
      if (this.enemiesLeft <= 0 && this.enemies.length === 0) {
        this.state = 'stageclear';
        this.setBanner('关卡完成', 2000);
        Sound.win();
        setTimeout(() => {
          if (this.state !== 'stageclear') return;
          if (this.stage >= STAGES.length + 2) {
            this.victory();
          } else {
            this.startStage(this.stage + 1);
          }
        }, 1800);
      }
    },

    gameOver(won) {
      if (this.state === 'gameover' || this.state === 'victory') return;
      this.state = 'gameover';
      Sound.gameOver();
      showOverlay({
        title: '游戏结束',
        desc: this.baseAlive ? '你的坦克全部损毁' : '基地被摧毁',
        stats: [['得分', this.score], ['关卡', this.stage], ['击毁', this.totalKills]],
        primary: '再来一局',
        onPrimary: () => this.reset(true),
        secondary: '返回菜单',
        onSecondary: () => showMenu(),
      });
    },

    victory() {
      this.state = 'victory';
      Sound.win();
      showOverlay({
        title: '胜利！',
        desc: '你守住了基地，击退了所有敌军',
        stats: [['得分', this.score], ['关卡', this.stage], ['击毁', this.totalKills]],
        primary: '再玩一次',
        onPrimary: () => this.reset(true),
        secondary: '返回菜单',
        onSecondary: () => showMenu(),
      });
    },

    pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      showOverlay({
        title: '暂停',
        desc: '按 P 或点击下方按钮继续',
        stats: [['得分', this.score], ['关卡', this.stage]],
        primary: '继续',
        onPrimary: () => this.resume(),
        secondary: '重新开始',
        onSecondary: () => this.reset(true),
      });
    },

    resume() {
      if (this.state !== 'paused') return;
      this.state = 'playing';
      hideOverlay();
      this.lastTime = performance.now();
    },

    /* ---------- 更新 ---------- */

    update(dt, input) {
      if (this.state !== 'playing') return;

      // 全局计时
      if (this.clockTimer > 0) this.clockTimer -= dt;
      if (this.shovelTimer > 0) {
        this.shovelTimer -= dt;
        if (this.shovelTimer <= 0) this.buildBaseWalls(T.BRICK);
      }
      if (this.bannerTimer > 0) this.bannerTimer -= dt;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 0.02);

      // 玩家
      if (this.player) this.player.update(dt, input);

      // 敌人生成
      const diff = DIFFICULTY[this.settings.difficulty];
      const pending = this.enemiesLeft - this.enemies.length;
      if (pending > 0 && this.enemies.length < diff.maxAlive) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          this.spawnEnemy();
          this.spawnTimer = diff.spawnMs;
        }
      }

      // 敌人
      const frozen = this.clockTimer > 0;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (frozen) { e.tick(dt); continue; }
        // 同屏敌人越多，单个敌人越「懒」，避免瞬间被围殴
        if (this.enemies.length >= 3 && Math.random() < 0.35) { e.tick(dt); continue; }
        e.update(dt);
      }
      this.enemies = this.enemies.filter(e => !e.dead);

      // 子弹
      for (const b of this.bullets) {
        if (!b.dead) b.update(dt);
      }
      this.bullets = this.bullets.filter(b => !b.dead);

      // 道具
      for (const pu of this.powerups) {
        pu.update(dt);
        if (!pu.dead && this.player && !this.player.spawning &&
            aabb(pu, this.player)) {
          pu.dead = true;
          this.applyPowerUp(pu);
        }
      }
      this.powerups = this.powerups.filter(p => !p.dead);

      // 爆炸
      for (const ex of this.explosions) ex.update(dt);
      this.explosions = this.explosions.filter(ex => ex.t < ex.dur);

      // 粒子
      for (const p of this.particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.94;
        p.vy *= 0.94;
        p.life -= p.decay;
      }
      this.particles = this.particles.filter(p => p.life > 0);

      // 炮口火光衰减在 Tank.update 之外统一处理
      for (const e of this.enemies) e.muzzle = Math.max(0, e.muzzle - dt * 0.2);
      if (this.player) this.player.muzzle = Math.max(0, this.player.muzzle - dt * 0.2);
    },

    spawnEnemy() {
      const points = [
        { c: 0, r: 0 },
        { c: 6, r: 0 },
        { c: 12, r: 0 },
      ];
      const pt = points[this.spawnPointIndex % points.length];
      this.spawnPointIndex++;

      // 出生点被占用则顺延
      const x = tileCenter(pt.c) - TANK_SIZE / 2;
      const y = tileCenter(pt.r) - TANK_SIZE / 2;
      const box = { x, y, w: TANK_SIZE, h: TANK_SIZE };
      if (this.player && !this.player.spawning && aabb(box, this.player)) return;
      if (this.enemies.some(e => aabb(box, e))) return;

      const level = this.stage;
      // 高关卡出更多强力敌人
      const pool = level <= 1 ? [0, 0, 1] : level <= 2 ? [0, 1, 1, 2] : [1, 2, 2, 3];
      const type = choice(pool);
      const e = new Enemy(x, y, type, level);

      // 第 carrierIndex 个敌人携带道具
      const spawnedCount = this.enemiesTotal - (this.enemiesLeft - this.enemies.length);
      if (spawnedCount === this.carrierIndex) e.carrier = true;

      this.enemies.push(e);
      // 出生闪光
      this.addSparks(e.cx, e.cy, 10, '#9be8ff');
    },

    /* ---------- 渲染 ---------- */

    render() {
      ctx.save();

      // 屏幕震动
      if (this.shake > 0.2) {
        ctx.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));
      }

      // 背景
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(-20, -20, W + 40, H + 40);

      // 地面网格（细微纹理）
      ctx.strokeStyle = 'rgba(255,255,255,.018)';
      ctx.lineWidth = 1;
      for (let i = 1; i < COLS; i++) {
        ctx.beginPath();
        ctx.moveTo(i * TILE, 0);
        ctx.lineTo(i * TILE, H);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * TILE);
        ctx.lineTo(W, i * TILE);
        ctx.stroke();
      }

      if (true) {
        this.drawTerrain(T.BRICK);
        this.drawTerrain(T.STEEL);
        this.drawWater();
        this.drawBase();

        // 道具
        for (const pu of this.powerups) pu.draw(ctx);

        // 坦克
        for (const e of this.enemies) e.draw(ctx);
        if (this.player) this.player.draw(ctx);

        // 子弹
        for (const b of this.bullets) b.draw(ctx);

        // 草丛盖在坦克之上
        this.drawTrees();

        // 粒子
        for (const p of this.particles) {
          ctx.globalAlpha = Math.max(0, p.life);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // 爆炸
        for (const ex of this.explosions) ex.draw(ctx);

        // 冻结效果
        if (this.clockTimer > 0) {
          ctx.fillStyle = `rgba(120, 200, 255, ${0.06 + Math.sin(Date.now() / 200) * 0.03})`;
          ctx.fillRect(0, 0, W, H);
        }
      }

      // 关卡横幅
      if (this.bannerTimer > 0) {
        const a = Math.min(1, this.bannerTimer / 400);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgba(5,8,12,.72)';
        ctx.fillRect(0, H / 2 - 30, W, 60);
        ctx.fillStyle = '#f5c542';
        ctx.font = 'bold 22px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.bannerText, W / 2, H / 2);
        ctx.restore();
      }

      ctx.restore();
    },

    drawTerrain(type) {
      const brickPal = ['#a8452a', '#c25c35', '#8e3822'];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const t = terrain[idx(c, r)];
          if (t !== type) continue;
          const x = c * TILE;
          const y = r * TILE;

          if (t === T.BRICK) {
            // 8x8 小砖块
            for (let by = 0; by < TILE; by += 8) {
              const offset = (by / 8) % 2 === 0 ? 0 : 4;
              for (let bx = -offset; bx < TILE; bx += 8) {
                const px = x + bx;
                const pw = Math.min(8, x + TILE - px);
                if (pw <= 0) continue;
                ctx.fillStyle = brickPal[(by / 8 + Math.abs(bx / 8)) % 2 === 0 ? 0 : 1];
                ctx.fillRect(px + 0.5, y + by + 0.5, pw - 1, 7);
                ctx.fillStyle = 'rgba(255,255,255,.10)';
                ctx.fillRect(px + 0.5, y + by + 0.5, pw - 1, 1.5);
              }
            }
          } else if (t === T.STEEL) {
            ctx.fillStyle = '#7d8894';
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = '#aebac7';
            ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
            ctx.fillStyle = '#8d99a6';
            ctx.fillRect(x + 8, y + 8, TILE - 16, TILE - 16);
            ctx.fillStyle = 'rgba(255,255,255,.5)';
            ctx.fillRect(x + 2, y + 2, 3, 3);
            ctx.fillRect(x + TILE - 5, y + 2, 3, 3);
            ctx.fillRect(x + 2, y + TILE - 5, 3, 3);
            ctx.fillRect(x + TILE - 5, y + TILE - 5, 3, 3);
          }
        }
      }
    },

    drawWater() {
      const t = Date.now() / 600;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (terrain[idx(c, r)] !== T.WATER) continue;
          const x = c * TILE;
          const y = r * TILE;
          ctx.fillStyle = '#16407a';
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = 'rgba(90, 170, 255, .28)';
          for (let i = 0; i < 3; i++) {
            const wy = y + 6 + i * 9 + Math.sin(t + c + r + i) * 1.5;
            const wx = x + 4 + Math.sin(t * 1.3 + i * 2 + c) * 4;
            ctx.fillRect(wx, wy, 10, 2);
            ctx.fillRect(wx + 16, wy + 3, 8, 2);
          }
        }
      }
    },

    drawTrees() {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (terrain[idx(c, r)] !== T.TREES) continue;
          const x = c * TILE;
          const y = r * TILE;
          ctx.fillStyle = '#1f4d2e';
          ctx.fillRect(x, y, TILE, TILE);
          // 叶簇
          const blobs = [
            [8, 9, 8], [22, 10, 7], [14, 20, 9], [25, 23, 6], [5, 22, 5],
          ];
          for (let i = 0; i < blobs.length; i++) {
            const [bx, by, br] = blobs[i];
            ctx.fillStyle = i % 2 === 0 ? '#2c6b3e' : '#357a48';
            ctx.beginPath();
            ctx.arc(x + bx, y + by, br, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = 'rgba(140, 220, 150, .22)';
          ctx.beginPath();
          ctx.arc(x + 11, y + 9, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },

    drawBase() {
      const x = this.baseX;
      const y = this.baseY;

      if (!this.baseAlive) {
        // 残骸
        ctx.save();
        ctx.fillStyle = '#2a2320';
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#4a3a30';
        ctx.fillRect(x - 10, y + 2, 8, 6);
        ctx.fillRect(x + 2, y - 8, 7, 7);
        ctx.restore();
        return;
      }

      // 基座
      ctx.fillStyle = '#3d2f22';
      ctx.fillRect(x - 12, y - 10, 24, 22);
      ctx.fillStyle = '#6b5237';
      ctx.fillRect(x - 10, y - 8, 20, 8);

      // 屋顶（金色三角）
      ctx.fillStyle = '#f5c542';
      ctx.beginPath();
      ctx.moveTo(x, y - 14);
      ctx.lineTo(x + 13, y - 2);
      ctx.lineTo(x - 13, y - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#c99a1a';
      ctx.beginPath();
      ctx.moveTo(x, y - 14);
      ctx.lineTo(x + 13, y - 2);
      ctx.lineTo(x, y - 2);
      ctx.closePath();
      ctx.fill();

      // 门
      ctx.fillStyle = '#1c1610';
      ctx.fillRect(x - 3, y + 2, 6, 9);

      // 旗帜微光
      ctx.save();
      ctx.globalAlpha = 0.35 + Math.sin(Date.now() / 500) * 0.15;
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.arc(x, y - 6, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  };

  /* ------------------------------------------------------------------ *
   * 8. 输入
   * ------------------------------------------------------------------ */

  const Input = (() => {
    const keys = new Set();
    const dirStack = [];        // 记录按下顺序，最后按下的优先
    let firePressed = false;
    let touchDir = null;

    const KEYMAP = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      w: 'up', s: 'down', a: 'left', d: 'right',
      W: 'up', S: 'down', A: 'left', D: 'right',
    };
    const FIRE_KEYS = new Set([' ', 'j', 'J', 'k', 'K', 'Enter', 'z', 'Z']);

    function pushDir(dir) {
      const i = dirStack.indexOf(dir);
      if (i !== -1) dirStack.splice(i, 1);
      dirStack.push(dir);
    }
    function removeDir(dir) {
      const i = dirStack.indexOf(dir);
      if (i !== -1) dirStack.splice(i, 1);
    }

    window.addEventListener('keydown', (e) => {
      const dir = KEYMAP[e.key];
      if (dir) {
        e.preventDefault();
        if (!keys.has(dir)) { keys.add(dir); pushDir(dir); }
        return;
      }
      if (FIRE_KEYS.has(e.key)) {
        e.preventDefault();
        firePressed = true;
        keys.add('fire');
        return;
      }
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
        e.preventDefault();
        if (game.state === 'playing') game.pause();
        else if (game.state === 'paused') game.resume();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        if (game.state !== 'menu') game.reset(true);
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        Sound.enabled = !Sound.enabled;
        game.setBanner(Sound.enabled ? '音效开启' : '音效关闭', 800);
      }
    });

    window.addEventListener('keyup', (e) => {
      const dir = KEYMAP[e.key];
      if (dir) { keys.delete(dir); removeDir(dir); }
      if (FIRE_KEYS.has(e.key)) keys.delete('fire');
    });

    window.addEventListener('blur', () => {
      keys.clear();
      dirStack.length = 0;
      if (game.state === 'playing') game.pause();
    });

    // 触屏
    function bindTouch() {
      document.querySelectorAll('.tbtn[data-dir]').forEach((btn) => {
        const dir = btn.dataset.dir;
        const on = (e) => {
          e.preventDefault();
          touchDir = dir;
          pushDir('touch:' + dir);
          btn.classList.add('on');
        };
        const off = (e) => {
          e.preventDefault();
          if (touchDir === dir) touchDir = null;
          removeDir('touch:' + dir);
          btn.classList.remove('on');
        };
        btn.addEventListener('touchstart', on, { passive: false });
        btn.addEventListener('touchend', off, { passive: false });
        btn.addEventListener('touchcancel', off, { passive: false });
        btn.addEventListener('mousedown', on);
        btn.addEventListener('mouseup', off);
        btn.addEventListener('mouseleave', off);
      });

      const fireBtn = document.getElementById('fireBtn');
      const fOn = (e) => { e.preventDefault(); keys.add('touchfire'); fireBtn.classList.add('on'); };
      const fOff = (e) => { e.preventDefault(); keys.delete('touchfire'); fireBtn.classList.remove('on'); };
      fireBtn.addEventListener('touchstart', fOn, { passive: false });
      fireBtn.addEventListener('touchend', fOff, { passive: false });
      fireBtn.addEventListener('touchcancel', fOff, { passive: false });
      fireBtn.addEventListener('mousedown', fOn);
      fireBtn.addEventListener('mouseup', fOff);
      fireBtn.addEventListener('mouseleave', fOff);
    }

    return {
      lastDir() {
        // 触屏方向优先（仍在按住）
        for (let i = dirStack.length - 1; i >= 0; i--) {
          const d = dirStack[i];
          if (d.startsWith('touch:')) return d.slice(6);
          if (keys.has(d)) return d;
        }
        return null;
      },
      fire() { return keys.has('fire') || keys.has('touchfire'); },
      reset() { dirStack.length = 0; keys.clear(); },
    };
  })();

  /* ------------------------------------------------------------------ *
   * 9. UI 绑定
   * ------------------------------------------------------------------ */

  const $ = (s) => document.querySelector(s);
  const el = {
    stage: $('#stage'),
    menu: $('#menu'),
    overlay: $('#overlay'),
    ovTitle: $('#ovTitle'),
    ovDesc: $('#ovDesc'),
    ovStats: $('#ovStats'),
    ovPrimary: $('#ovPrimary'),
    ovSecondary: $('#ovSecondary'),
    score: $('#score'),
    stageNo: $('#stageNo'),
    enemyLeft: $('#enemyLeft'),
    lives: $('#lives'),
  };

  let overlayHandlers = { onPrimary: null, onSecondary: null };

  function showOverlay({ title, desc, stats = [], primary, onPrimary, secondary, onSecondary }) {
    el.ovTitle.textContent = title;
    el.ovDesc.textContent = desc || '';
    el.ovStats.innerHTML = stats.map(([k, v]) => `<div><b>${v}</b>${k}</div>`).join('');
    el.ovPrimary.textContent = primary || '继续';
    el.ovPrimary.style.display = primary ? '' : 'none';
    el.ovSecondary.textContent = secondary || '重新开始';
    overlayHandlers = { onPrimary, onSecondary };
    el.overlay.classList.remove('hidden');
  }

  function hideOverlay() { el.overlay.classList.add('hidden'); }
  function hideMenu() { el.menu.classList.add('hidden'); }
  function showMenu() {
    game.state = 'menu';
    el.menu.classList.remove('hidden');
    hideOverlay();
  }

  el.ovPrimary.addEventListener('click', () => {
    Sound.init(); Sound.resume();
    if (overlayHandlers.onPrimary) overlayHandlers.onPrimary();
  });
  el.ovSecondary.addEventListener('click', () => {
    Sound.init(); Sound.resume();
    if (overlayHandlers.onSecondary) overlayHandlers.onSecondary();
  });

  // 菜单里的分段控件
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        const group = seg.dataset.group;
        const val = btn.dataset.value;
        if (group === 'difficulty') game.settings.difficulty = val;
        if (group === 'lives') game.settings.lives = parseInt(val, 10);
        if (group === 'sound') {
          Sound.enabled = val === 'on';
          game.settings.sound = val === 'on';
        }
      });
    });
  });

  $('#startBtn').addEventListener('click', () => {
    Sound.init();
    Sound.resume();
    Input.reset();
    game.reset(true);
  });

  $('#restartBtn').addEventListener('click', () => {
    Input.reset();
    game.reset(true);
  });

  function updateHUD() {
    el.score.textContent = game.score;
    el.stageNo.textContent = `${game.stage} / ${STAGES.length}`;
    el.enemyLeft.textContent = Math.max(0, game.enemiesLeft);
    el.lives.innerHTML = Array.from({ length: Math.max(0, game.lives) }, () => '<i></i>').join('');
  }

  /* ---------- 自适应布局 ---------- */

  function layout() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const touchEl = document.getElementById('touch');
    if (isTouch) touchEl.classList.remove('hidden');

    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const wide = vw > 780;

    // 预留空间：宽屏时右侧 HUD + 边距；移动端预留触控键
    const reservedH = isTouch ? 210 : 40;
    // 固定为 14px 内边距 + 边框 6px 约 26px
    const maxW = wide ? vw - 210 - 26 * 2 - 40 : vw - 32;
    const maxH = vh - reservedH - (isTouch ? 10 : 36);

    const size = Math.floor(Math.max(220, Math.min(maxW, maxH, 640)));

    el.stage.style.width = size + 'px';
    el.stage.style.height = size + 'px';
    const hud = document.querySelector('.hud');
    if (hud) hud.style.height = size + 'px';
  }

  /* ---------- 主循环 ---------- */

  function loop(now) {
    const dt = Math.min(50, now - (game.lastTime || now));
    game.lastTime = now;

    game.update(dt, Input);
    game.render();

    requestAnimationFrame(loop);
  }

  /* ---------- 启动 ---------- */

  setupCanvas();
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 120));

  // 预渲染菜单背景：先加载一关地图做视觉底图
  loadStage(1);
  game.baseX = tileCenter(6);
  game.baseY = tileCenter(12);

  requestAnimationFrame(loop);

  // 暴露给调试
  window.__tank = game;
  window.__tank.debugTile = getTile;
})();
