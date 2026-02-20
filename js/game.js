/**
 * DROP ZONE - Canvas + 素の JavaScript
 * 仕様: GAME_SPEC.md
 */

(function () {
  'use strict';

  // --- 定数（仕様どおり） ---
  const GRID = 10;
  const GAME_SIZE = 400;
  const CELL = GAME_SIZE / GRID;

  const DIR_UP = 0;
  const DIR_RIGHT = 1;
  const DIR_DOWN = 2;
  const DIR_LEFT = 3;
  const DX = [0, 1, 0, -1];
  const DY = [1, 0, -1, 0];

  const MOVE_STUN_MS = 200;
  const MAGIC_COOLDOWN_MS = 2000;
  const MAGIC_STUN_MS = 600;
  const MAGIC_GLOW_INTERVAL_MS = 50;
  const MAGIC_DROP_INTERVAL_MS = 100;
  const PANEL_RESPAWN_DELAY_MS = 5000;
  const PANEL_RESPAWN_ANIM_MS = 200;
  const CPU_MOVE_INTERVAL_MS = 500;
  const CPU_TURN_STUN_MS = 500;
  const READY_DURATION_MS = 1200;
  const FIGHT_DURATION_MS = 800;
  const SPRITE_CHANGE_INTERVAL_MS = 100;

  const PHASE_TITLE = 'title';
  const PHASE_READY = 'ready';
  const PHASE_FIGHT = 'fight';
  const PHASE_BATTLE = 'battle';
  const PHASE_RESULT = 'result';

  const CPU_COLORS = ['#0ea5e9', '#f43f5e', '#eab308', '#22c55e']; // 2P青,3P赤,4P黄,4P緑 → 2P,3P,4P なので 3色で 2,3,4

  // 1P スプライト割り当て（PNG_Player 配下）
  // [方向] = { idle: 静止時, move: [移動1, 移動2] } 0.1秒間隔で交互表示
  const P1_SPRITE_MAP = {
    [DIR_UP]:    { idle: '02', move: ['03', '04'] },
    [DIR_DOWN]:  { idle: '23', move: ['01', '24'] },
    [DIR_RIGHT]: { idle: '11', move: ['12', '13'] },
    [DIR_LEFT]:  { idle: '14', move: ['15', '16'] },
  };

  // --- DOM ---
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const titleScreenEl = document.getElementById('title-screen');
  const resultScreenEl = document.getElementById('result-screen');
  const resultTextEl = document.getElementById('result-text');
  const resultSubEl = document.getElementById('result-sub');

  // --- 状態 ---
  let phase = PHASE_TITLE;
  let grid = []; // grid[y][x] = { present: bool, droppedAt: number | null, respawnAnimStart: number | null }
  let players = []; // { x, y, dir, alive, moveStunUntil, magicStunUntil, magicCooldownUntil, lastDirChangeAt (CPU), lastMoveAt (CPU) }
  let magic = { active: false, phase: null, cells: [], glowIndex: 0, dropIndex: 0, nextAt: 0, caster: null };
  let phaseTimer = 0; // READY/FIGHT 用
  let winner = null; // 1..4 or 'draw'
  let player1Sprites = []; // 方向0..3 → [idle画像, 移動1, 移動2]
  let spriteFrame = 0;
  let lastSpriteTime = 0;
  let keys = { w: false, a: false, s: false, d: false, space: false };

  // --- ユーティリティ ---
  function now() { return performance.now(); }

  function initGrid() {
    grid = [];
    for (let y = 0; y < GRID; y++) {
      grid[y] = [];
      for (let x = 0; x < GRID; x++) {
        grid[y][x] = { present: true, droppedAt: null, respawnAnimStart: null };
      }
    }
  }

  function initPlayers() {
    players = [
      { x: 4, y: 0, dir: DIR_UP, alive: true, moveStunUntil: 0, magicStunUntil: 0, magicCooldownUntil: 0, lastDirChangeAt: 0, lastMoveAt: 0 },
      { x: 5, y: 9, dir: DIR_DOWN, alive: true, moveStunUntil: 0, magicStunUntil: 0, magicCooldownUntil: 0, lastDirChangeAt: 0, lastMoveAt: 0 },
      { x: 9, y: 4, dir: DIR_LEFT, alive: true, moveStunUntil: 0, magicStunUntil: 0, magicCooldownUntil: 0, lastDirChangeAt: 0, lastMoveAt: 0 },
      { x: 0, y: 5, dir: DIR_RIGHT, alive: true, moveStunUntil: 0, magicStunUntil: 0, magicCooldownUntil: 0, lastDirChangeAt: 0, lastMoveAt: 0 },
    ];
  }

  function panelPresent(x, y) {
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return false;
    const c = grid[y][x];
    if (!c.present) return false;
    return true;
  }

  function panelCanStand(x, y) {
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return false;
    const c = grid[y][x];
    if (!c.present) return false;
    return true;
  }

  function getPlayerAt(x, y) {
    for (let i = 0; i < players.length; i++) {
      if (players[i].alive && players[i].x === x && players[i].y === y) return i;
    }
    return -1;
  }

  function getMagicTargetCells(casterIndex) {
    const p = players[casterIndex];
    const cells = [];
    let x = p.x + DX[p.dir];
    let y = p.y + DY[p.dir];
    while (x >= 0 && x < GRID && y >= 0 && y < GRID) {
      cells.push({ x, y });
      x += DX[p.dir];
      y += DY[p.dir];
    }
    // 線上にいる相手のマスを追加（まだ含まれていなければ）
    for (let i = 0; i < players.length; i++) {
      if (i === casterIndex || !players[i].alive) continue;
      const op = players[i];
      const onLine = (p.dir === DIR_UP || p.dir === DIR_DOWN) ? (op.x === p.x) : (op.y === p.y);
      if (!onLine) continue;
      const dist = (p.dir === DIR_UP || p.dir === DIR_DOWN) ? (op.y - p.y) * (p.dir === DIR_UP ? 1 : -1) : (op.x - p.x) * (p.dir === DIR_RIGHT ? 1 : -1);
      if (dist <= 0) continue;
      const key = `${op.x},${op.y}`;
      if (!cells.some(c => c.x === op.x && c.y === op.y)) {
        cells.push({ x: op.x, y: op.y });
      }
    }
    // 順序を「自分から遠い順」ではなく、隣から端までに並べ直す
    const out = [];
    let nx = p.x + DX[p.dir];
    let ny = p.y + DY[p.dir];
    while (nx >= 0 && nx < GRID && ny >= 0 && ny < GRID) {
      if (cells.some(c => c.x === nx && c.y === ny)) out.push({ x: nx, y: ny });
      nx += DX[p.dir];
      ny += DY[p.dir];
    }
    return out;
  }

  function startMagic(casterIndex) {
    if (magic.active) return;
    const p = players[casterIndex];
    if (!p.alive || now() < p.magicStunUntil || now() < p.magicCooldownUntil) return;
    const cells = getMagicTargetCells(casterIndex);
    if (cells.length === 0) return;
    magic = {
      active: true,
      phase: 'glow',
      cells,
      glowIndex: 0,
      dropIndex: 0,
      nextAt: now() + MAGIC_GLOW_INTERVAL_MS,
      caster: casterIndex,
    };
    players[casterIndex].magicStunUntil = now() + MAGIC_STUN_MS;
    players[casterIndex].magicCooldownUntil = now() + MAGIC_COOLDOWN_MS;
  }

  function updateMagic(dt) {
    if (!magic.active) return;
    const t = now();
    if (t < magic.nextAt) return;
    if (magic.phase === 'glow') {
      magic.glowIndex++;
      if (magic.glowIndex >= magic.cells.length) {
        magic.phase = 'drop';
        magic.dropIndex = 0;
        magic.nextAt = t + MAGIC_DROP_INTERVAL_MS;
      } else {
        magic.nextAt = t + MAGIC_GLOW_INTERVAL_MS;
      }
      return;
    }
    if (magic.phase === 'drop') {
      const cell = magic.cells[magic.dropIndex];
      const g = grid[cell.y][cell.x];
      g.present = false;
      g.droppedAt = t;
      const who = getPlayerAt(cell.x, cell.y);
      if (who >= 0) players[who].alive = false;
      magic.dropIndex++;
      if (magic.dropIndex >= magic.cells.length) {
        magic.active = false;
        return;
      }
      magic.nextAt = t + MAGIC_DROP_INTERVAL_MS;
    }
  }

  function updatePanelRespawns() {
    const t = now();
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const c = grid[y][x];
        if (c.present) continue;
        if (!c.droppedAt) continue;
        if (c.respawnAnimStart === null) {
          if (t - c.droppedAt >= PANEL_RESPAWN_DELAY_MS) {
            c.respawnAnimStart = t;
          }
        } else if (t - c.respawnAnimStart >= PANEL_RESPAWN_ANIM_MS) {
          c.present = true;
          c.droppedAt = null;
          c.respawnAnimStart = null;
        }
      }
    }
  }

  function checkDeathByPanel() {
    for (let i = 0; i < players.length; i++) {
      if (!players[i].alive) continue;
      if (!panelCanStand(players[i].x, players[i].y)) players[i].alive = false;
    }
  }

  function countAlive() {
    let n = 0;
    for (let i = 0; i < players.length; i++) if (players[i].alive) n++;
    return n;
  }

  function decideWinner() {
    if (players[0].alive === false) return 2;
    const alive = countAlive();
    if (alive === 0) return 'draw';
    if (alive === 1) {
      for (let i = 0; i < players.length; i++) if (players[i].alive) return i + 1;
    }
    return null;
  }

  // --- 1P 入力・移動・向き・攻撃 ---
  function tryMoveHuman() {
    const p = players[0];
    if (!p.alive || phase !== PHASE_BATTLE || now() < p.moveStunUntil) return;
    let dx = 0, dy = 0, newDir = -1;
    if (keys.w) { dy = 1; newDir = DIR_UP; }
    if (keys.s) { dy = -1; newDir = DIR_DOWN; }
    if (keys.a) { dx = -1; newDir = DIR_LEFT; }
    if (keys.d) { dx = 1; newDir = DIR_RIGHT; }
    if (dx === 0 && dy === 0) return;
    if (dx !== 0 && dy !== 0) {
      dx = 0;
      dy = 0;
      newDir = -1;
    }
    if (newDir >= 0) p.dir = newDir;
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (nx === p.x && ny === p.y) return;
    if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) return;
    if (!panelCanStand(nx, ny)) return;
    if (getPlayerAt(nx, ny) >= 0) return;
    p.x = nx;
    p.y = ny;
    p.moveStunUntil = now() + MOVE_STUN_MS;
  }

  function tryMagicHuman() {
    if (phase !== PHASE_BATTLE) return;
    startMagic(0);
  }

  // --- CPU ---
  function getCpuMoveOptions(i) {
    const p = players[i];
    const opts = [];
    for (let d = 0; d < 4; d++) {
      const nx = p.x + DX[d];
      const ny = p.y + DY[d];
      if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) continue;
      if (!panelCanStand(nx, ny)) continue;
      if (getPlayerAt(nx, ny) >= 0) continue;
      opts.push(d);
    }
    return opts;
  }

  function cpuHasEnemyOnLine(i) {
    const p = players[i];
    let x = p.x + DX[p.dir];
    let y = p.y + DY[p.dir];
    while (x >= 0 && x < GRID && y >= 0 && y < GRID) {
      const who = getPlayerAt(x, y);
      if (who >= 0 && who !== i) return true;
      x += DX[p.dir];
      y += DY[p.dir];
    }
    return false;
  }

  function updateCpu(dt) {
    const t = now();
    for (let i = 1; i < players.length; i++) {
      const p = players[i];
      if (!p.alive || phase !== PHASE_BATTLE) continue;
      if (magic.active) continue;

      if (t >= p.magicCooldownUntil && t >= p.magicStunUntil && cpuHasEnemyOnLine(i)) {
        startMagic(i);
        continue;
      }

      if (t < p.moveStunUntil) continue;
      if (t - p.lastDirChangeAt < CPU_TURN_STUN_MS) continue;
      if (t - p.lastMoveAt < CPU_MOVE_INTERVAL_MS) continue;

      const opts = getCpuMoveOptions(i);
      if (opts.length === 0) continue;
      const d = opts[Math.floor(Math.random() * opts.length)];
      if (p.dir !== d) {
        p.dir = d;
        p.lastDirChangeAt = t;
        p.moveStunUntil = t + CPU_TURN_STUN_MS;
        continue;
      }
      p.x += DX[d];
      p.y += DY[d];
      p.lastMoveAt = t;
      p.moveStunUntil = t + CPU_MOVE_INTERVAL_MS;
    }
  }

  // --- 描画 ---
  function drawPanel(x, y, state) {
    const px = x * CELL;
    const py = (GRID - 1 - y) * CELL;
    if (state === 'normal') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1, py + 1, CELL - 2, CELL - 2);
    } else if (state === 'glow') {
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
    } else if (state === 'drop') {
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
    } else if (state === 'respawn') {
      const c = grid[y][x];
      const elapsed = now() - (c.respawnAnimStart || 0);
      const ratio = Math.min(1, elapsed / PANEL_RESPAWN_ANIM_MS);
      ctx.fillStyle = `rgba(74, 85, 104, ${ratio})`;
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
    }
  }

  function getPanelDrawState(x, y) {
    const c = grid[y][x];
    if (c.present && !c.respawnAnimStart) return 'normal';
    if (!c.present && c.respawnAnimStart === null) return 'hole';
    if (!c.present && c.droppedAt) return 'hole';
    if (c.respawnAnimStart !== null) return 'respawn';
    return 'normal';
  }

  function isMagicGlowCell(x, y) {
    if (!magic.active || magic.phase !== 'glow') return false;
    for (let i = 0; i <= magic.glowIndex && i < magic.cells.length; i++) {
      const c = magic.cells[i];
      if (c.x === x && c.y === y) return true;
    }
    return false;
  }

  function isMagicDropCell(x, y) {
    if (!magic.active || magic.phase !== 'drop') return false;
    for (let i = 0; i < magic.dropIndex; i++) {
      const c = magic.cells[i];
      if (c.x === x && c.y === y) return true;
    }
    return false;
  }

  function drawGridAndPanels() {
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const c = grid[y][x];
        if (!c.present && !c.respawnAnimStart) {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(x * CELL, (GRID - 1 - y) * CELL, CELL, CELL);
          continue;
        }
        if (isMagicGlowCell(x, y)) drawPanel(x, y, 'glow');
        else if (isMagicDropCell(x, y)) drawPanel(x, y, 'drop');
        else if (c.respawnAnimStart !== null) drawPanel(x, y, 'respawn');
        else if (c.present) drawPanel(x, y, 'normal');
      }
    }
  }

  function drawPlayer1P(x, y, dir, moving) {
    const px = x * CELL + CELL / 2;
    const py = (GRID - 1 - y) * CELL + CELL / 2;
    if (player1Sprites[dir] && player1Sprites[dir].length > 0) {
      const frames = player1Sprites[dir]; // [idle, move0, move1]
      const idx = moving ? (spriteFrame % 2) + 1 : 0;
      const img = frames[idx] || frames[0];
      if (img && img.complete) {
        const size = CELL * 0.9;
        ctx.drawImage(img, px - size / 2, py - size / 2, size, size);
        return;
      }
    }
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(px, py, CELL * 0.35, 0, Math.PI * 2);
    ctx.fill();
    const dx = DX[dir] * CELL * 0.25;
    const dy = -DY[dir] * CELL * 0.25;
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(px + dx, py - dy);
    ctx.lineTo(px + dx * 0.5 + dy * 0.5, py - dy * 0.5 - dx * 0.5);
    ctx.lineTo(px + dx * 0.5 - dy * 0.5, py - dy * 0.5 + dx * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  function drawCpuPlayer(x, y, dir, colorIndex) {
    const px = x * CELL + CELL / 2;
    const py = (GRID - 1 - y) * CELL + CELL / 2;
    const w = CELL * 0.55;
    const h = CELL * 0.55;
    const r = CELL * 0.12;
    const left = px - w / 2;
    const top = py - h / 2;

    // 角丸の立方体（本体）
    ctx.fillStyle = CPU_COLORS[colorIndex];
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, r);
      ctx.fill();
    } else {
      roundRect(ctx, left, top, w, h, r);
      ctx.fill();
    }

    // 向きに応じた目玉の位置（上=0, 右=1, 下=2, 左=3）かわいらしめ
    const eyeR = CELL * 0.1;
    const pupilR = CELL * 0.065;
    const eyeOffset = CELL * 0.12;
    const faceOffset = CELL * 0.18;
    let ex1, ey1, ex2, ey2;
    if (dir === DIR_UP) {
      ex1 = px - eyeOffset; ey1 = py - faceOffset;
      ex2 = px + eyeOffset; ey2 = py - faceOffset;
    } else if (dir === DIR_DOWN) {
      ex1 = px - eyeOffset; ey1 = py + faceOffset;
      ex2 = px + eyeOffset; ey2 = py + faceOffset;
    } else if (dir === DIR_RIGHT) {
      ex1 = px + faceOffset; ey1 = py - eyeOffset;
      ex2 = px + faceOffset; ey2 = py + eyeOffset;
    } else {
      ex1 = px - faceOffset; ey1 = py - eyeOffset;
      ex2 = px - faceOffset; ey2 = py + eyeOffset;
    }

    function drawEye(ex, ey) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(ex, ey, pupilR, 0, Math.PI * 2);
      ctx.fill();
    }
    drawEye(ex1, ey1);
    drawEye(ex2, ey2);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function drawPlayers() {
    const t = now();
    if (t - lastSpriteTime >= SPRITE_CHANGE_INTERVAL_MS) {
      lastSpriteTime = t;
      spriteFrame++;
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      if (i === 0) {
        const moving = t < p.moveStunUntil + 50 && t > p.moveStunUntil - MOVE_STUN_MS;
        drawPlayer1P(p.x, p.y, p.dir, moving);
      } else {
        drawCpuPlayer(p.x, p.y, p.dir, i - 1);
      }
    }
  }

  function updatePlayerStatusDOM() {
    const t = now();
    for (let i = 0; i < 4; i++) {
      const fillEl = document.getElementById('gauge-' + i);
      const cardEl = document.querySelector('.player-card[data-player="' + i + '"]');
      if (!fillEl || !cardEl) continue;

      const p = players[i];
      const alive = p && p.alive;
      const remaining = alive ? Math.max(0, p.magicCooldownUntil - t) : MAGIC_COOLDOWN_MS;
      const ratio = alive ? (1 - remaining / MAGIC_COOLDOWN_MS) : 0;

      fillEl.style.width = (Math.min(1, ratio) * 100) + '%';
      fillEl.classList.toggle('is-ready', ratio >= 1);
      cardEl.classList.toggle('is-dead', !alive);
    }
    const attackBtn = document.querySelector('.attack-btn');
    if (attackBtn) {
      const p0 = players[0];
      const ready = phase === PHASE_BATTLE && p0 && p0.alive && t >= p0.magicCooldownUntil;
      attackBtn.classList.toggle('is-ready', !!ready);
    }
  }

  function drawOverlay() {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, GAME_SIZE, GAME_SIZE);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    if (phase === PHASE_READY) {
      ctx.fillText('READY', GAME_SIZE / 2, GAME_SIZE / 2);
    } else if (phase === PHASE_FIGHT) {
      ctx.fillText('FIGHT!!', GAME_SIZE / 2, GAME_SIZE / 2);
    }
  }

  function render() {
    if (titleScreenEl) titleScreenEl.classList.toggle('is-visible', phase === PHASE_TITLE);
    if (resultScreenEl && resultTextEl && resultSubEl) {
      const showResult = phase === PHASE_RESULT;
      resultScreenEl.classList.toggle('is-visible', showResult);
      if (showResult) {
        const isPlayerWin = winner === 1;
        const isDraw = winner === 'draw';
        const isDefeat = !isPlayerWin && !isDraw;
        resultTextEl.textContent = isPlayerWin ? 'PLAYER WINS!' : isDraw ? 'DRAW' : 'DEFEAT';
        resultTextEl.classList.toggle('draw', isDraw);
        resultTextEl.classList.toggle('defeat', isDefeat);
        resultScreenEl.classList.toggle('victory', isPlayerWin);
        resultScreenEl.classList.toggle('defeat', isDefeat);
        const isMobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
        resultSubEl.textContent = isMobile ? 'Tap to Restart' : 'Space to Restart';
      }
    }
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, GAME_SIZE, GAME_SIZE);
    drawGridAndPanels();
    drawPlayers();
    updatePlayerStatusDOM();
    if (phase === PHASE_READY || phase === PHASE_FIGHT || phase === PHASE_RESULT) {
      drawOverlay();
    }
  }

  // --- ゲームフロー ---
  function goTitle() {
    phase = PHASE_TITLE;
    winner = null;
  }

  function goReady() {
    phase = PHASE_READY;
    phaseTimer = now() + READY_DURATION_MS;
  }

  function goFight() {
    phase = PHASE_FIGHT;
    phaseTimer = now() + FIGHT_DURATION_MS;
  }

  function goBattle() {
    phase = PHASE_BATTLE;
  }

  function goResult(w) {
    phase = PHASE_RESULT;
    winner = w;
  }

  function startNewGame() {
    initGrid();
    initPlayers();
    magic = { active: false, phase: null, cells: [], glowIndex: 0, dropIndex: 0, nextAt: 0, caster: null };
    goReady();
  }

  function updatePhase(dt) {
    const t = now();
    if (phase === PHASE_READY && t >= phaseTimer) goFight();
    else if (phase === PHASE_FIGHT && t >= phaseTimer) goBattle();
    if (phase === PHASE_BATTLE) {
      updatePanelRespawns();
      updateMagic(dt);
      checkDeathByPanel();
      const w = decideWinner();
      if (w !== null) goResult(w);
    }
  }

  function update(dt) {
    updatePhase(dt);
    if (phase === PHASE_BATTLE) {
      tryMoveHuman();
      updateCpu(dt);
    }
    render();
  }

  // --- 入力（WASD / 矢印キーで移動・向き） ---
  function onKeyDown(e) {
    const k = e.key;
    const kLower = k.toLowerCase();
    if (kLower === 'w' || k === 'ArrowUp') keys.w = true;
    if (kLower === 'a' || k === 'ArrowLeft') keys.a = true;
    if (kLower === 's' || k === 'ArrowDown') keys.s = true;
    if (kLower === 'd' || k === 'ArrowRight') keys.d = true;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') e.preventDefault();
    if (k === ' ') { e.preventDefault(); keys.space = true; }
    if (e.repeat) return;
    if (phase === PHASE_TITLE && k === ' ') startNewGame();
    else if (phase === PHASE_RESULT && k === ' ') startNewGame();
    else if (phase === PHASE_BATTLE && k === ' ') tryMagicHuman();
  }

  function onKeyUp(e) {
    const k = e.key;
    const kLower = k.toLowerCase();
    if (kLower === 'w' || k === 'ArrowUp') keys.w = false;
    if (kLower === 'a' || k === 'ArrowLeft') keys.a = false;
    if (kLower === 's' || k === 'ArrowDown') keys.s = false;
    if (kLower === 'd' || k === 'ArrowRight') keys.d = false;
    if (k === ' ') keys.space = false;
  }

  // --- 1P スプライト読み込み（P1_SPRITE_MAP に従い PNG_Player 配下を読み込み） ---
  function loadSprites(cb) {
    const base = 'assets/player/player_';
    const toLoad = [];
    [DIR_UP, DIR_RIGHT, DIR_DOWN, DIR_LEFT].forEach((dir) => {
      const m = P1_SPRITE_MAP[dir];
      if (!m) return;
      player1Sprites[dir] = [null, null, null];
      toLoad.push({ dir, frame: 0, file: m.idle });
      toLoad.push({ dir, frame: 1, file: m.move[0] });
      toLoad.push({ dir, frame: 2, file: m.move[1] });
    });
    if (toLoad.length === 0) { cb(); return; }
    let loaded = 0;
    toLoad.forEach(({ dir, frame, file }) => {
      const img = new Image();
      img.onload = () => { loaded++; if (loaded === toLoad.length) cb(); };
      img.onerror = () => { loaded++; if (loaded === toLoad.length) cb(); };
      img.src = base + file + '.png';
      player1Sprites[dir][frame] = img;
    });
  }

  let lastTime = 0;
  function loop(t) {
    const dt = t - lastTime;
    lastTime = t;
    update(Math.min(dt, 100));
    requestAnimationFrame(loop);
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // --- スマホ用仮想ボタン ---
  function onVirtualKeyDown(keyName) {
    if (keyName === 'w') keys.w = true;
    if (keyName === 'a') keys.a = true;
    if (keyName === 's') keys.s = true;
    if (keyName === 'd') keys.d = true;
    if (keyName === 'space') {
      keys.space = true;
      if (phase === PHASE_TITLE) startNewGame();
      else if (phase === PHASE_RESULT) startNewGame();
      else if (phase === PHASE_BATTLE) tryMagicHuman();
    }
  }

  function onVirtualKeyUp(keyName) {
    if (keyName === 'w') keys.w = false;
    if (keyName === 'a') keys.a = false;
    if (keyName === 's') keys.s = false;
    if (keyName === 'd') keys.d = false;
    if (keyName === 'space') keys.space = false;
  }

  (function initVirtualControls() {
    const btns = document.querySelectorAll('.dpad-btn, .attack-btn');
    btns.forEach((btn) => {
      const keyName = btn.getAttribute('data-key');
      if (!keyName) return;
      const onDown = (e) => {
        e.preventDefault();
        onVirtualKeyDown(keyName);
      };
      const onUp = (e) => {
        e.preventDefault();
        onVirtualKeyUp(keyName);
      };
      btn.addEventListener('pointerdown', onDown);
      btn.addEventListener('pointerup', onUp);
      btn.addEventListener('pointerleave', onUp);
      btn.addEventListener('pointercancel', onUp);
      btn.addEventListener('touchstart', onDown, { passive: false });
      btn.addEventListener('touchend', onUp, { passive: false });
      btn.addEventListener('touchcancel', onUp, { passive: false });
    });
  })();

  loadSprites(() => {
    initGrid();
    initPlayers();
    lastTime = performance.now();
    lastSpriteTime = lastTime;
    requestAnimationFrame(loop);
  });
})();
