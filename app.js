(() => {
  'use strict';

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });

  const ui = document.getElementById('ui');
  const buttons = Array.from(ui.querySelectorAll('button[data-mode]'));

  // ---- Simulation config ----
  const MODES = /** @type {const} */ (['rain', 'snow', 'wind', 'fog', 'thunder', 'sunny', 'night']);

  let mode = 'rain';

  // Fixed timestep for consistent movement.
  const FIXED_DT = 1 / 60;
  let acc = 0;
  let lastT = performance.now();
  let paused = false;

  // Grid (cells map to character positions).
  let cols = 0;
  let rows = 0;
  let cellW = 10;
  let cellH = 18;

  // Dirty-cell rendering.
  /** @type {Uint16Array|null} */
  let prevCode = null;
  /** @type {Uint16Array|null} */
  let nextCode = null;

  // Map cell index -> last drawn code. We also need a fast char lookup.
  const CHARSET = [
    ' ',
    '.',
    '/',
    '*',
    '+',
    '~',
    '-',
    '░',
    '▒',
    '▓',
    '#'
  ];
  // code 0 is space.

  // Convert 0..n-1 codes directly to glyph.
  /** @param {number} code */
  const codeToChar = (code) => CHARSET[code] ?? ' ';

  // ---- Procedural noise: value noise + FBM (implemented from scratch) ----
  function fract(x) { return x - Math.floor(x); }

  function hash2i(xi, yi, seed) {
    // Deterministic integer hash -> [0,1)
    let h = xi | 0;
    h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ ((yi | 0) + seed * 1013), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  function valueNoise2D(x, y, seed) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const xf = x - x0;
    const yf = y - y0;

    const u = smoothstep(xf);
    const v = smoothstep(yf);

    const n00 = hash2i(x0, y0, seed);
    const n10 = hash2i(x0 + 1, y0, seed);
    const n01 = hash2i(x0, y0 + 1, seed);
    const n11 = hash2i(x0 + 1, y0 + 1, seed);

    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return nx0 + (nx1 - nx0) * v;
  }

  function fbm2D(x, y, seed, octaves = 4) {
    let amp = 0.5;
    let freq = 1.0;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * valueNoise2D(x * freq, y * freq, seed + i * 17);
      norm += amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return sum / (norm || 1);
  }

  // Convenience: noise in [0,1] from cell coordinates.
  function n01(i, j, t, seed, scale) {
    // include t in coordinates so motion is continuous.
    return fbm2D(i * scale + seed, j * scale - t * 0.35, seed * 3.1, 4);
  }

  // ---- Rendering helpers ----
  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    // Choose a font size based on viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Character aspect: typical monospace is taller than wide.
    // We'll target ~ (vw/cols) with reasonable cell size.
    const targetCellW = Math.max(6, Math.floor(vw / 110));
    const targetCellH = Math.max(10, Math.floor(vh / 55));

    cellW = targetCellW;
    cellH = targetCellH;

    cols = Math.max(10, Math.floor(vw / cellW));
    rows = Math.max(10, Math.floor(vh / cellH));

    // Set actual canvas resolution.
    canvas.width = Math.floor(cols * cellW * dpr);
    canvas.height = Math.floor(rows * cellH * dpr);

    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = `${cellH}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;

    // Allocate code buffers.
    const N = cols * rows;
    prevCode = new Uint16Array(N);
    nextCode = new Uint16Array(N);

    // Deterministic initial buffers.
    // We'll align buffers during init by drawing the first frame into nextCode,
    // then copying/switching so prevCode represents what's on screen.
    prevCode.fill(0);
    nextCode.fill(0);
  }

  function drawAll() {
    // Draw everything once after resize.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cols * cellW, rows * cellH);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        const code = nextCode[idx];
        const ch = codeToChar(code);
        if (ch !== ' ') {
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.fillText(ch, x * cellW, y * cellH);
        }
      }
    }

    // Swap buffers.
    const tmp = prevCode;
    prevCode = nextCode;
    nextCode = tmp;
  }

  function setCode(idx, code) {
    nextCode[idx] = code;
  }

  function renderDirty() {
    // Proper dirty rendering: only erase/redraw cells that changed.
    // Important: prevCode/nextCode swap is done only after draw completes.

    for (let i = 0; i < prevCode.length; i++) {
      const a = prevCode[i];
      const b = nextCode[i];
      if (a === b) continue;

      const x = i % cols;
      const y = (i / cols) | 0;

      // Erase cell background.
      ctx.fillStyle = '#000';
      ctx.fillRect(x * cellW, y * cellH, cellW, cellH);

      const ch = codeToChar(b);
      if (ch !== ' ') {
        // Slightly vary intensity by code.
        let alpha = 0.92;
        if (b === 7) alpha = 0.70; // ░
        if (b === 8) alpha = 0.82; // ▒
        if (b === 9) alpha = 0.95; // ▓
        if (b === 1) alpha = 0.88; // .
        if (b === 10) alpha = 0.98; // #

        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.fillText(ch, x * cellW, y * cellH);
      }
    }

    // Swap buffers so prevCode represents what's on screen.
    const tmp = prevCode;
    prevCode = nextCode;
    nextCode = tmp;
  }


  // ---- Mode rendering (procedural per-cell; no particles) ----
  function drawFrame(t) {
    const time = t;
    const seed = 1337;

    // Precompute normalized coordinates.
    // Keep math lightweight.
    for (let y = 0; y < rows; y++) {
      const yf = y / Math.max(1, rows - 1);
      for (let x = 0; x < cols; x++) {
        const xf = x / Math.max(1, cols - 1);
        const idx = y * cols + x;

        let code = 0;

        if (mode === 'rain') {
          // Diagonal streaks: falling down with per-cell x jitter.
          const jitter = fbm2D(x * 0.22, y * 0.13 + seed, seed, 3);
          const speed = 1.8 + jitter * 1.6;
          const p = x * 0.35 + time * speed;
          const diag = (p - y * 0.9);
          const w = Math.abs(diag - Math.round(diag));

          // '/' streaks plus '.' droplets
          if (w < 0.18) {
            // Occasionally use /
            code = (jitter > 0.5) ? 2 : 1; // '/' or '.'
            // Make it a streak by lighting a couple of neighbor rows.
            const span = (0.12 + jitter * 0.10);
            if (w > span) code = 0;
          } else {
            // random '.'
            const n = valueNoise2D(x * 0.15 + time * 0.2, y * 0.12 - time * 0.6, seed + 2);
            if (n > 0.965) code = 1;
          }
        } else if (mode === 'snow') {
          // Drifting down with wind.
          const wind = Math.sin(time * 0.35) * 0.8;
          const nx = x / cols + wind * (0.2 + fbm2D(y * 0.03, time * 0.1, seed, 3) * 0.5);
          const ny = y / rows + time * (0.22 + 0.25 * fbm2D(x * 0.04, time * 0.11, seed + 9, 3));

          const n = fbm2D(nx * 6.0, ny * 6.0, seed + 5, 4);
          const n2 = valueNoise2D(x * 0.12 + time * 0.06, y * 0.12 - time * 0.10, seed + 7);

          // Combine gating to avoid sync.
          if (n > 0.73 && n2 > 0.78) {
            code = (n > 0.83) ? 3 : 4; // '*' or '+'
          }
        } else if (mode === 'wind') {
          // Horizontal streaks; random phase per row.
          const rowPhase = fbm2D(y * 0.07, seed, seed + 11, 3);
          const flow = time * (1.3 + rowPhase * 1.4);
          const p = x / cols * 10 + flow;
          const mask = valueNoise2D(x * 0.25 + rowPhase, y * 0.08 + time * 0.05, seed + 3);

          // Streak bands.
          const frac = p - Math.floor(p);
          const band = Math.abs(frac - 0.3);
          if (band < 0.06 && mask > 0.45) code = (rowPhase > 0.5) ? 5 : 6; // '~' or '-'
          else {
            // occasional fragments
            if (mask > 0.965) code = (rowPhase > 0.5) ? 5 : 6;
          }
        } else if (mode === 'fog') {
          // Density-based shading with FBM; flow upward/downward.
          const drift = time * 0.08;
          const s = fbm2D(x * 0.06 + seed, y * 0.07 + drift, seed + 19, 5);
          const s2 = fbm2D(x * 0.10 - drift * 0.7, y * 0.04 + drift * 0.3, seed + 23, 4);
          const density = (s * 0.7 + s2 * 0.3);

          if (density > 0.62) {
            if (density > 0.80) code = 9; // ▓
            else if (density > 0.72) code = 8; // ▒
            else code = 7; // ░
          } else {
            code = 0;
          }

          // Add a few soft voids
          if (code !== 0) {
            const cut = valueNoise2D(x * 0.03 + time * 0.02, y * 0.05 - time * 0.02, seed + 29);
            if (cut < 0.08) code = 0;
          }
        } else if (mode === 'thunder') {
          // Rain base + sporadic lightning flashes (#)
          const flashGate = thunderFlash(time, x, y, seed);

          // Rain-like
          const jitter = fbm2D(x * 0.22, y * 0.13 + seed + 77, seed, 3);
          const speed = 1.9 + jitter * 1.7;
          const p = x * 0.35 + time * speed;
          const diag = (p - y * 0.9);
          const w = Math.abs(diag - Math.round(diag));

          if (flashGate > 0.55) {
            // Bright background during flash.
            code = (flashGate > 0.82) ? 10 : 1; // # or .
          } else {
            if (w < 0.18) code = (jitter > 0.48) ? 2 : 1;
            else {
              const n = valueNoise2D(x * 0.15 + time * 0.25, y * 0.12 - time * 0.6, seed + 2);
              if (n > 0.97) code = 1;
            }
          }
        } else if (mode === 'sunny') {
          // Subtle heat haze: '.' shimmering.
          const drift = time * 0.18;
          const n = fbm2D(x * 0.10 + drift, y * 0.04 - drift * 0.5, seed + 41, 5);
          const n2 = fbm2D(x * 0.06 - drift * 0.6, y * 0.09 + drift * 0.2, seed + 47, 4);
          const h = (n * 0.65 + n2 * 0.35);
          if (h > 0.72) {
            const q = valueNoise2D(x * 0.15 + drift * 0.7, y * 0.12 - drift * 0.3, seed + 53);
            if (q > 0.7) code = 1;
          }
        } else if (mode === 'night') {
          // Twinkling stars '.' with noise gating.
          const n = fbm2D(x * 0.07 + seed, y * 0.09 + time * 0.02, seed + 61, 5);
          const tw = valueNoise2D(x * 0.2 - time * 0.03, y * 0.17 + time * 0.02, seed + 67);

          // Only place stars occasionally to avoid overdraw.
          const star = (n > 0.67) && (tw > 0.72);
          if (star) {
            // twinkle by time quantization
            const twinkle = Math.sin(time * (0.8 + n * 2.5) + x * 0.2 + y * 0.1);
            if (twinkle > 0.6) code = 1;
          }
        }

        setCode(idx, code);
      }
    }
  }

  function thunderFlash(t, x, y, seed) {
    // Produce sporadic lightning along a few diagonals.
    const intervals = 6.0;
    const cycle = t / intervals;
    const gateN = valueNoise2D(Math.floor(cycle), 0, seed + 101);

    // Lightning happens when gateN crosses threshold.
    const phase = cycle - Math.floor(cycle);

    const chance = gateN;
    // Choose number of flashes per long cycle.
    const active = chance > 0.6 ? 1 : 0;
    if (!active) return 0;

    // Lightning lasts briefly.
    const life = Math.max(0, 1 - Math.abs(phase - 0.22) / 0.08);

    if (life <= 0) return 0;

    // Shape: some diagonals.
    const diag1 = (x + y * 0.6);
    const diag2 = (x * 0.4 + y);
    const n1 = valueNoise2D(diag1 * 0.08 + t * 0.6, 0.2, seed + 201);
    const n2 = valueNoise2D(diag2 * 0.09 - t * 0.5, 0.8, seed + 202);

    const beam = (n1 > 0.72 ? 1 : 0) * (n2 > 0.68 ? 1 : 0);
    // Add occasional bloom.
    const bloom = valueNoise2D(x * 0.08 + t * 0.9, y * 0.08 - t * 0.3, seed + 203);
    return life * (beam ? 1 : 0.45) * (0.7 + bloom * 0.8);
  }

  // ---- Main loop ----
  function frame(now) {
    if (!paused) {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      acc += dt;

      // fixed timestep
      while (acc >= FIXED_DT) {
        acc -= FIXED_DT;
        stepSimulation(FIXED_DT);
      }

      // Render after stepping to keep smooth.
      renderDirty();
    }

    requestAnimationFrame(frame);
  }

  let simTime = 0;

  function stepSimulation(dt) {
    simTime += dt;
    // Keep t in a stable range.
    const t = simTime;

    // Fill nextCode via procedural sampling per mode.
    drawFrame(t);
  }

  // ---- Events ----
  function setMode(m) {
    if (!MODES.includes(m)) return;
    mode = m;
    buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === m));

    // Force redraw on mode change.
    if (prevCode) prevCode.fill(65535);
  }

  ui.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });

  function handleVisibility() {
    paused = document.hidden;
    if (!paused) {
      lastT = performance.now();
      acc = 0;
      if (prevCode) prevCode.fill(65535);
    }
  }

  document.addEventListener('visibilitychange', handleVisibility);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    // Debounce.
    cancelAnimationFrame(resizeTimer);
    resizeTimer = requestAnimationFrame(() => {
      resize();
    });
  });

  // ---- Init ----
  function init() {
    resize();
    // First mode state: rain.
    setMode('rain');

    // Deterministic first frame: draw into nextCode, then align prevCode.
    if (prevCode && nextCode) {
      drawFrame(0);

      // Copy next -> prev so renderDirty has nothing to “fix” after init.
      prevCode.set(nextCode);

      // Render once fully using drawAll-like behavior (no dirty logic needed).
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cols * cellW, rows * cellH);

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const idx = y * cols + x;
          const code = nextCode[idx];
          const ch = codeToChar(code);
          if (ch !== ' ') {
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.fillText(ch, x * cellW, y * cellH);
          }
        }
      }
    }

    requestAnimationFrame(frame);
  }

  init();
})();

