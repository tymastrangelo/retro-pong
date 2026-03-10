/**
 * PONG — Retro-style, browser-playable
 *
 * Modes:
 *   • 1-Player vs AI  (Easy / Medium / Hard)
 *   • 2-Player local  (same keyboard)
 *
 * Controls:
 *   Player 1 (left):  W / S
 *   Player 2 (right): ↑ / ↓
 *   Pause:            P  or  Escape
 */

// ─────────────────────────────────────────────
// Canvas setup — fills the viewport at 16:9
// ─────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

const BASE_W = 800;
const BASE_H = 600;

function resize() {
  const scaleX = window.innerWidth  / BASE_W;
  const scaleY = window.innerHeight / BASE_H;
  const scale  = Math.min(scaleX, scaleY);
  canvas.style.width  = `${BASE_W * scale}px`;
  canvas.style.height = `${BASE_H * scale}px`;
  canvas.width  = BASE_W;
  canvas.height = BASE_H;
}
window.addEventListener('resize', resize);
resize();

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const PADDLE_W      = 12;
const PADDLE_H      = 90;
const PADDLE_MARGIN = 20;
const BALL_SIZE     = 10;
const WINNING_SCORE = 7;
const SERVE_DELAY   = 800; // ms before ball launches after a point

const COLORS = {
  fg:      '#e8e8e8',
  dimmed:  '#666666',
  accent:  '#ffffff',
  glow:    'rgba(255,255,255,0.15)',
  net:     '#2a2a2a',
};

// AI difficulty settings: { reactionZone, maxSpeed, errorFactor }
// reactionZone  — how far ball must be before AI reacts (0 = always reacting)
// maxSpeed      — max px/frame the AI paddle can move
// errorFactor   — random offset added to target y (0–1 scale of half paddle height)
const AI_PROFILES = {
  easy:   { reactionZone: BASE_W * 0.45, maxSpeed: 2.8, errorFactor: 0.9 },
  medium: { reactionZone: BASE_W * 0.55, maxSpeed: 4.5, errorFactor: 0.45 },
  hard:   { reactionZone: BASE_W * 0.90, maxSpeed: 7.2, errorFactor: 0.1 },
};

// ─────────────────────────────────────────────
// Input state
// ─────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.key] = true;
  handleMenuKey(e.key);
});
window.addEventListener('keyup',  e => { keys[e.key] = false; });

// ─────────────────────────────────────────────
// Sound (Web Audio API — tiny retro bleeps)
// ─────────────────────────────────────────────
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function beep(freq = 440, type = 'square', duration = 0.06, vol = 0.18) {
  try {
    const ac  = getAudio();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ac.currentTime);
    gain.gain.setValueAtTime(vol, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime + duration);
  } catch (_) { /* audio blocked — silently ignore */ }
}

const SFX = {
  paddle: () => beep(300, 'square', 0.05, 0.2),
  wall:   () => beep(220, 'square', 0.05, 0.15),
  score:  () => beep(110, 'sawtooth', 0.3, 0.25),
  win:    () => { beep(523, 'square', 0.15, 0.2); setTimeout(() => beep(659, 'square', 0.15, 0.2), 160); setTimeout(() => beep(784, 'square', 0.3, 0.2), 320); },
  select: () => beep(440, 'square', 0.06, 0.15),
  start:  () => { beep(330, 'square', 0.1, 0.15); setTimeout(() => beep(440, 'square', 0.15, 0.2), 120); },
};

// ─────────────────────────────────────────────
// Game state machine
// ─────────────────────────────────────────────
// States: 'menu' | 'mode_select' | 'difficulty' | 'playing' | 'paused' | 'won'
let state = 'menu';

// Menu cursor positions
const MENU_ITEMS      = ['MULTIPLAYER', 'VS AI'];
const DIFF_ITEMS      = ['EASY', 'MEDIUM', 'HARD'];
let menuCursor        = 0;
let diffCursor        = 1; // default: medium
let gameMode          = null; // 'multi' | 'ai'
let aiDifficulty      = 'medium';

// ─────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────
const p1 = {
  x: PADDLE_MARGIN,
  y: BASE_H / 2 - PADDLE_H / 2,
  w: PADDLE_W,
  h: PADDLE_H,
  score: 0,
  speed: 6,
  dy: 0,
};

const p2 = {
  x: BASE_W - PADDLE_MARGIN - PADDLE_W,
  y: BASE_H / 2 - PADDLE_H / 2,
  w: PADDLE_W,
  h: PADDLE_H,
  score: 0,
  speed: 6,
  dy: 0,
};

const ball = {
  x: BASE_W / 2,
  y: BASE_H / 2,
  size: BALL_SIZE,
  dx: 0,
  dy: 0,
  speed: 5,
  active: false,
};

// AI state
let aiTarget     = BASE_H / 2;
let aiError      = 0;
let serveTimeout = null;

// ─────────────────────────────────────────────
// Game logic helpers
// ─────────────────────────────────────────────
function resetBall(serveToward = 1) {
  ball.x      = BASE_W / 2;
  ball.y      = BASE_H / 2;
  ball.active = false;
  ball.dx     = 0;
  ball.dy     = 0;

  clearTimeout(serveTimeout);
  serveTimeout = setTimeout(() => {
    const angle  = (Math.random() * 40 - 20) * (Math.PI / 180); // ±20°
    ball.speed   = 5;
    ball.dx      = Math.cos(angle) * ball.speed * serveToward;
    ball.dy      = Math.sin(angle) * ball.speed;
    ball.active  = true;
  }, SERVE_DELAY);
}

function resetGame() {
  p1.score = 0;
  p2.score = 0;
  p1.y = BASE_H / 2 - PADDLE_H / 2;
  p2.y = BASE_H / 2 - PADDLE_H / 2;
  aiTarget = BASE_H / 2;
  aiError  = 0;
  resetBall(Math.random() < 0.5 ? 1 : -1);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─────────────────────────────────────────────
// Collision — returns paddle hit fraction (-1…1)
// from center so we can add angle deflection
// ─────────────────────────────────────────────
function ballHitsPaddle(paddle) {
  return (
    ball.x - ball.size / 2 < paddle.x + paddle.w &&
    ball.x + ball.size / 2 > paddle.x             &&
    ball.y - ball.size / 2 < paddle.y + paddle.h  &&
    ball.y + ball.size / 2 > paddle.y
  );
}

function deflectOffPaddle(paddle) {
  const relativeIntersect = (paddle.y + paddle.h / 2) - ball.y;
  const normalized        = relativeIntersect / (paddle.h / 2);
  const bounceAngle       = normalized * (Math.PI / 4); // max 45°
  const speed             = Math.min(ball.speed + 0.3, 14); // cap speed
  const dir               = ball.dx < 0 ? 1 : -1;

  ball.speed = speed;
  ball.dx    = dir * Math.cos(bounceAngle) * speed;
  ball.dy    = -Math.sin(bounceAngle) * speed;

  // Push ball out of paddle so it doesn't re-collide
  if (dir === 1) ball.x = paddle.x + paddle.w + ball.size / 2 + 1;
  else           ball.x = paddle.x - ball.size / 2 - 1;

  SFX.paddle();
}

// ─────────────────────────────────────────────
// AI brain
// ─────────────────────────────────────────────
function updateAI() {
  const profile = AI_PROFILES[aiDifficulty];

  // Only react when ball is traveling toward AI side and within reaction zone
  const ballMovingTowardAI = ball.dx > 0;
  const inZone = BASE_W - ball.x < profile.reactionZone;

  if (ball.active && ballMovingTowardAI && inZone) {
    // Update target with a small error offset (recalculated on each score)
    aiTarget = ball.y + aiError;
  } else if (!ball.active || !ballMovingTowardAI) {
    // Drift back to center slowly when ball is moving away
    aiTarget = BASE_H / 2;
  }

  const paddleCenter = p2.y + p2.h / 2;
  const diff         = aiTarget - paddleCenter;
  const move         = clamp(diff, -profile.maxSpeed, profile.maxSpeed);

  p2.y = clamp(p2.y + move, 0, BASE_H - p2.h);
}

function randomizeAIError() {
  const profile = AI_PROFILES[aiDifficulty];
  aiError = (Math.random() * 2 - 1) * PADDLE_H * profile.errorFactor;
}

// ─────────────────────────────────────────────
// Update — called every frame
// ─────────────────────────────────────────────
function update() {
  if (state !== 'playing') return;

  // ── Player 1 input (W / S) ──
  if (keys['w'] || keys['W']) p1.y -= p1.speed;
  if (keys['s'] || keys['S']) p1.y += p1.speed;
  p1.y = clamp(p1.y, 0, BASE_H - p1.h);

  // ── Player 2 input / AI ──
  if (gameMode === 'multi') {
    if (keys['ArrowUp'])   p2.y -= p2.speed;
    if (keys['ArrowDown']) p2.y += p2.speed;
    p2.y = clamp(p2.y, 0, BASE_H - p2.h);
  } else {
    updateAI();
  }

  if (!ball.active) return;

  // ── Ball movement ──
  ball.x += ball.dx;
  ball.y += ball.dy;

  // ── Wall collision (top / bottom) ──
  if (ball.y - ball.size / 2 <= 0) {
    ball.y = ball.size / 2 + 1;
    ball.dy = Math.abs(ball.dy);
    SFX.wall();
  }
  if (ball.y + ball.size / 2 >= BASE_H) {
    ball.y = BASE_H - ball.size / 2 - 1;
    ball.dy = -Math.abs(ball.dy);
    SFX.wall();
  }

  // ── Paddle collisions ──
  if (ball.dx < 0 && ballHitsPaddle(p1)) deflectOffPaddle(p1);
  if (ball.dx > 0 && ballHitsPaddle(p2)) deflectOffPaddle(p2);

  // ── Scoring ──
  if (ball.x + ball.size / 2 < 0) {
    // P2 scores
    p2.score++;
    SFX.score();
    randomizeAIError();
    if (p2.score >= WINNING_SCORE) {
      endGame();
    } else {
      resetBall(1); // serve toward p1 (the one who missed)
    }
  } else if (ball.x - ball.size / 2 > BASE_W) {
    // P1 scores
    p1.score++;
    SFX.score();
    randomizeAIError();
    if (p1.score >= WINNING_SCORE) {
      endGame();
    } else {
      resetBall(-1); // serve toward p2
    }
  }
}

function endGame() {
  clearTimeout(serveTimeout);
  ball.active = false;
  state = 'won';
  SFX.win();
}

// ─────────────────────────────────────────────
// Drawing helpers
// ─────────────────────────────────────────────
function clearScreen() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, BASE_W, BASE_H);
}

function drawGlowRect(x, y, w, h, color = COLORS.accent) {
  ctx.shadowColor = color;
  ctx.shadowBlur  = 12;
  ctx.fillStyle   = color;
  ctx.fillRect(x, y, w, h);
  ctx.shadowBlur  = 0;
}

function drawText(text, x, y, size = 16, color = COLORS.fg, align = 'center') {
  ctx.font      = `bold ${size}px 'Courier New', monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.shadowColor = color;
  ctx.shadowBlur  = size < 24 ? 6 : 18;
  ctx.fillText(text, x, y);
  ctx.shadowBlur  = 0;
}

function drawNet() {
  const segH   = 20;
  const segGap = 10;
  const x      = BASE_W / 2 - 1;
  ctx.fillStyle = '#1e1e1e';
  for (let y = 0; y < BASE_H; y += segH + segGap) {
    ctx.fillRect(x, y, 2, segH);
  }
}

function drawPaddle(paddle) {
  drawGlowRect(paddle.x, paddle.y, paddle.w, paddle.h, COLORS.accent);
}

function drawBall() {
  if (!ball.active) return;
  drawGlowRect(
    ball.x - ball.size / 2,
    ball.y - ball.size / 2,
    ball.size,
    ball.size,
    COLORS.accent
  );
}

function drawScores() {
  drawText(p1.score, BASE_W / 4,     70, 64, COLORS.fg);
  drawText(p2.score, BASE_W * 3 / 4, 70, 64, COLORS.fg);
}

// ─────────────────────────────────────────────
// Screen renderers
// ─────────────────────────────────────────────
function drawGame() {
  clearScreen();
  drawNet();
  drawScores();
  drawPaddle(p1);
  drawPaddle(p2);
  drawBall();

  // Player labels
  const p1Label = 'P1  W/S';
  const p2Label = gameMode === 'multi' ? '↑/↓  P2' : aiDifficulty.toUpperCase() + ' AI';
  drawText(p1Label,     BASE_W / 4,     14, 12, COLORS.dimmed);
  drawText(p2Label,     BASE_W * 3 / 4, 14, 12, COLORS.dimmed);
  drawText('[P] PAUSE', BASE_W / 2,     14, 11, '#333333');
}

function drawPaused() {
  drawGame();
  // dim overlay
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, BASE_W, BASE_H);
  drawText('PAUSED',           BASE_W / 2, BASE_H / 2 - 30, 48, COLORS.accent);
  drawText('PRESS P TO RESUME', BASE_W / 2, BASE_H / 2 + 30, 18, COLORS.dimmed);
  drawText('ESC → MAIN MENU',   BASE_W / 2, BASE_H / 2 + 60, 14, COLORS.dimmed);
}

function drawWon() {
  clearScreen();
  const winner     = p1.score >= WINNING_SCORE ? 1 : 2;
  const winnerName = (winner === 2 && gameMode === 'ai') ? aiDifficulty.toUpperCase() + ' AI' : `PLAYER ${winner}`;

  drawText('GAME OVER',    BASE_W / 2, BASE_H / 2 - 90, 20, COLORS.dimmed);
  drawText(winnerName,     BASE_W / 2, BASE_H / 2 - 30, 52, COLORS.accent);
  drawText('WINS!',        BASE_W / 2, BASE_H / 2 + 40, 52, COLORS.accent);

  drawText(`${p1.score} : ${p2.score}`, BASE_W / 2, BASE_H / 2 + 110, 28, COLORS.dimmed);

  blinkText('PRESS ENTER TO PLAY AGAIN', BASE_W / 2, BASE_H / 2 + 160, 14);
  drawText('ESC → MAIN MENU',           BASE_W / 2, BASE_H / 2 + 185, 13, COLORS.dimmed);
}

// Blink helper — uses timestamp
function blinkText(text, x, y, size) {
  if (Math.floor(Date.now() / 550) % 2 === 0) {
    drawText(text, x, y, size, COLORS.fg);
  }
}

function drawMenu() {
  clearScreen();

  // Title
  drawText('PONG', BASE_W / 2, 140, 100, COLORS.accent);
  drawText('RETRO EDITION', BASE_W / 2, 200, 16, COLORS.dimmed);

  // Menu items
  const startY = 290;
  const step   = 52;
  MENU_ITEMS.forEach((label, i) => {
    const y        = startY + i * step;
    const isActive = i === menuCursor;
    const color    = isActive ? COLORS.accent : COLORS.dimmed;
    drawText(label, BASE_W / 2, y, 24, color);
    if (isActive) drawText('▶', BASE_W / 2 - 90, y, 24, color);
  });

  blinkText('W/S + ENTER TO SELECT', BASE_W / 2, BASE_H - 60, 12);
  drawText('© 1972 INSPIRED', BASE_W / 2, BASE_H - 30, 10, '#333');
}

function drawDifficultyMenu() {
  clearScreen();
  drawText('SELECT DIFFICULTY', BASE_W / 2, 150, 26, COLORS.fg);

  const startY = 260;
  const step   = 60;
  DIFF_ITEMS.forEach((label, i) => {
    const y        = startY + i * step;
    const isActive = i === diffCursor;
    const color    = isActive ? COLORS.accent : COLORS.dimmed;

    drawText(label, BASE_W / 2, y, 28, color);
    if (isActive) drawText('▶', BASE_W / 2 - 90, y, 28, color);

    // Difficulty description
    const desc = ['REACTION SLOWED, ERRORS HIGH', 'BALANCED CHALLENGE', 'NEAR PERFECT OPPONENT'];
    drawText(desc[i], BASE_W / 2, y + 22, 10, isActive ? '#888' : '#333');
  });

  blinkText('W/S + ENTER TO SELECT', BASE_W / 2, BASE_H - 60, 12);
  drawText('ESC → BACK', BASE_W / 2, BASE_H - 35, 11, '#444');
}

// ─────────────────────────────────────────────
// Menu key handling
// ─────────────────────────────────────────────
function handleMenuKey(key) {
  if (state === 'menu') {
    if (key === 'w' || key === 'W' || key === 'ArrowUp') {
      menuCursor = (menuCursor - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
      SFX.select();
    } else if (key === 's' || key === 'S' || key === 'ArrowDown') {
      menuCursor = (menuCursor + 1) % MENU_ITEMS.length;
      SFX.select();
    } else if (key === 'Enter') {
      if (menuCursor === 0) {
        // Multiplayer
        gameMode = 'multi';
        SFX.start();
        resetGame();
        state = 'playing';
      } else {
        // AI — pick difficulty first
        state = 'difficulty';
        SFX.select();
      }
    }
  } else if (state === 'difficulty') {
    if (key === 'w' || key === 'W' || key === 'ArrowUp') {
      diffCursor = (diffCursor - 1 + DIFF_ITEMS.length) % DIFF_ITEMS.length;
      SFX.select();
    } else if (key === 's' || key === 'S' || key === 'ArrowDown') {
      diffCursor = (diffCursor + 1) % DIFF_ITEMS.length;
      SFX.select();
    } else if (key === 'Enter') {
      aiDifficulty = DIFF_ITEMS[diffCursor].toLowerCase();
      gameMode = 'ai';
      SFX.start();
      resetGame();
      state = 'playing';
    } else if (key === 'Escape') {
      state = 'menu';
    }
  } else if (state === 'playing') {
    if (key === 'p' || key === 'P') {
      state = 'paused';
    } else if (key === 'Escape') {
      // Pause first, not instant exit
      state = 'paused';
    }
  } else if (state === 'paused') {
    if (key === 'p' || key === 'P') {
      state = 'playing';
    } else if (key === 'Escape') {
      clearTimeout(serveTimeout);
      state = 'menu';
    }
  } else if (state === 'won') {
    if (key === 'Enter') {
      SFX.start();
      resetGame();
      state = 'playing';
    } else if (key === 'Escape') {
      state = 'menu';
    }
  }
}

// ─────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────
function draw() {
  switch (state) {
    case 'menu':       drawMenu();           break;
    case 'difficulty': drawDifficultyMenu(); break;
    case 'playing':    drawGame();           break;
    case 'paused':     drawPaused();         break;
    case 'won':        drawWon();            break;
  }
}

function gameLoop() {
  update();
  draw();
  requestAnimationFrame(gameLoop);
}

// Kick off
gameLoop();
