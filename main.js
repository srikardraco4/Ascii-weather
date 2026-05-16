(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });

  const hud = document.getElementById('hud');
  const buttons = Array.from(document.querySelectorAll('[data-mode]'));

  const MODES = {
    rain: 'rain',
    snow: 'snow',
    wind: 'wind',
    fog: 'fog',
    thunder: 'thunder',
    sunny: 'sunny',
    night: 'night'
  };

  let mode = MODES.rain;

  for (const b of buttons) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      for (const bb of buttons) bb.dataset.active = String(bb === b);
    });
  }
  // Activate default
  for (const bb of buttons) bb.dataset.active = String(bb.dataset.mode === mode);

  // --- Simulation parameters ---
  const CHAR_BG = '#000';
  const CHAR_FG = 'rgba(255,255,255,1)';

  // Dirty-cell renderer
  let cols = 0;
  let rows = 0;
  let cellW = 12;
  let cellH = 16;

  let charCurr = null;
  let charPrev = null;

  // Offscreen image not needed; just draw changed cells.
  ctx.textBaseline = 'top';

  // Fixed timestep
  const STEP_MS = 1000 / 60;
  let lastReal = performance.now();
  let acc = 0;
  let running = true;

  // Time for deterministic noise
  let t = 0;

  // --- Procedural value noise / FBM (from scratch) ---
  function hash2i(x, y, seed) {
    // Deterministic pseudo-random 32-bit
    let h = x | 0;
    h = (h * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695041) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = (h * 1274126177) | 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296; // [0,1)
  }

  function smoothstep(u) {
    return u * u * (3 - 2 * u);
  }

  function valueNoise2(x, y, seed) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const xf = x - x0;
    const yf = y - y0;

    const u = smoothstep(xf);
    const v = smoothstep(yf);

    const a = hash2i(x0, y0, seed);
    const b = hash2i(x0 + 1, y0, seed);
    const c = hash2i(x0, y0 + 1, seed);
    const d = hash2i(x0 + 1, y0 + 1, seed);

    const lerp1 = a + (b - a) * u;
    const lerp2 = c + (d - c) * u;
    return lerp1 + (lerp2 - lerp1) * v;
  }

  function fbm2(x, y, seed, octaves = 4) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * valueNoise2(x * freq, y * freq, seed + i * 1013);
      freq *= 2;
      amp *= 0.5;
    }
    return sum; // [0,1] approx
  }

  function fract(x) { return x - Math.floor(x); }

  function rand1(x, seed) {
    return hash2i(Math.floor(x), 0, seed);
  }

  // --- Resize & grid ---
  function setFontForCellSize() {
    // Choose a monospace font-size to fit cellW
    // Use cellH as line-height-like. We'll use font-size ~ cellH.
    ctx.font = `bold ${Math.max(10, Math.floor(cellH * 0.88))}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
  }

  function allocateGrid() {
    cols = Math.max(10, Math.floor(canvas.width / cellW));
    rows = Math.max(8, Math.floor(canvas.height / cellH));

    charCurr = new Uint16Array(cols * rows);
    charPrev = new Uint16Array(cols * rows);
    // 0 means background
    charPrev.fill(0);

    // Initial clear
    ctx.fillStyle = CHAR_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    // Responsive cell size: more columns on larger screens.
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Target character aspect: width ~ 0.6*height
    // Choose cellH based on viewport.
    const base = Math.max(10, Math.min(18, Math.floor(Math.min(w, h) / 45)));
    cellH = base;
    cellW = Math.max(8, Math.floor(cellH * 0.62));

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    setFontForCellSize();

    allocateGrid();
  }

  // Draw one cell if dirty
  function drawDirtyCell(i, chCode, alpha = 1) {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;

    if (chCode === 0) {
      // Clear cell region by overdrawing with bg. This avoids a full canvas clear.
      ctx.fillStyle = CHAR_BG;
      ctx.fillRect(x, y, cellW, cellH);
      return;
    }

    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    // Map code to character: stored as charCode
    const ch = String.fromCharCode(chCode);
    ctx.fillText(ch, x, y);
  }

  function setCell(i, ch, alpha = 1) {
    // Store as charCode; alpha computed at draw time.
    charCurr[i] = ch ? ch.charCodeAt(0) : 0;
    // We'll encode alpha in a parallel array lazily by recomputing in render.
  }

  function computeCell(i) {
    const cx = i % cols;
    const cy = (i / cols) | 0;

    const x = cx;
    const y = cy;

    // Normalize coords
    const nx = x / cols;
    const ny = y / rows;

    const seed = 1337;
    const speed = 1.0;

    // Time in noise space
    const T = t * speed;

    switch (mode) {
      case MODES.rain: {
        // Diagonal streaks using '/' and '.'
        // Use a tilted advection: sample along a diagonal line.
        const drift = T * 10;
        const u = (x + (y * 0.7) - drift);
        const v = (x * 0.15 - y * 0.25 + drift * 0.3);
        const n = fbm2(u * 0.08, v * 0.08, seed, 3);

        const q = (nx * 1.2 + ny * 0.4 + n * 0.9 + T * 0.15);
        const frac = q - Math.floor(q);

        if (frac > 0.86) return { ch: '/', alpha: 0.95 };
        if (frac > 0.70) return { ch: '.', alpha: 0.6 };
        return { ch: '', alpha: 0 };
      }
      case MODES.thunder: {
        // Mostly rain, plus lightning flashes with '#'
        const drift = T * 10;
        const u = (x + (y * 0.7) - drift);
        const v = (x * 0.15 - y * 0.25 + drift * 0.3);
        const n = fbm2(u * 0.08, v * 0.08, seed, 3);
        const q = (nx * 1.2 + ny * 0.4 + n * 0.9 + T * 0.15);
        const frac = q - Math.floor(q);

        // Lightning: random flashes across top, persist briefly.
        // Use value noise to decide current strike intensity.
        const lightningSeed = seed + 999;
        const flashN = fbm2(T * 0.35, nx * 2.2, lightningSeed, 3);
        const strikeChance = flashN;

        // Determine if a flash is active for this cell.
        // Thunder flashes more likely in upper half.
        const upper = 1 - ny;
        const intensity = (strikeChance > 0.72) ? (strikeChance - 0.72) / 0.28 : 0;
        const flash = intensity * upper;

        if (flash > 0.35 && y < rows * 0.6) {
          // Lightning column with branches (noise-based)
          const branch = fbm2(nx * 5 + T * 1.2, y * 0.15, seed + 77, 2);
          if (branch > 0.62) return { ch: '#', alpha: 0.9 };
          return { ch: '#', alpha: 0.65 };
        }

        if (frac > 0.86) return { ch: '/', alpha: 0.95 };
        if (frac > 0.70) return { ch: '.', alpha: 0.6 };
        return { ch: '', alpha: 0 };
      }
      case MODES.snow: {
        // Drifting '*' and '+'
        const driftX = T * 6;
        const driftY = T * 4;

        // Use noise as wind field for each cell.
        const wind = (fbm2(nx * 3 + T * 0.15, ny * 3, seed + 11, 4) - 0.5);

        const px = x + wind * 3 + driftX;
        const py = y + driftY * (0.6 + wind * 0.2);

        const n = fbm2(px * 0.09, py * 0.09, seed + 22, 3);
        const threshold = 0.72;
        const alive = n - threshold;

        if (alive > 0.04) {
          // Different symbol based on additional noise
          const s = fbm2(px * 0.2, py * 0.2, seed + 33, 2);
          if (s > 0.58) return { ch: '*', alpha: 0.85 };
          return { ch: '+', alpha: 0.65 };
        }
        // occasional specks
        const speck = valueNoise2(px * 0.25, py * 0.25, seed + 44);
        if (speck > 0.985) return { ch: '+', alpha: 0.6 };
        return { ch: '', alpha: 0 };
      }
      case MODES.wind: {
        // Horizontal '~' and '-' streaks
        const drift = T * 9;
        const band = fbm2(ny * 3 + T * 0.12, nx * 2.0, seed + 5, 4);
        const yth = Math.floor(band * 8);
        const phase = (x - drift) * 0.22 + yth;
        const frac = phase - Math.floor(phase);

        if (frac > 0.82) return { ch: '-', alpha: 0.85 };
        if (frac > 0.65) return { ch: '~', alpha: 0.65 };
        return { ch: '', alpha: 0 };
      }
      case MODES.fog: {
        // Density-based shading using ░▒▓
        const speed = 0.03;
        const vx = fbm2(T * speed, ny * 3.0, seed + 1, 4);
        const vy = fbm2(nx * 3.0, T * speed + 10.0, seed + 2, 4);

        const d = fbm2(nx * 5 + vx * 2.0, ny * 5 + vy * 2.0, seed + 3, 5);
        // Make fog also move with a mild drift
        const dd = fbm2(nx * 4 + T * 0.08, ny * 4, seed + 7, 4);
        const density = d * 0.65 + dd * 0.35;

        if (density < 0.48) return { ch: '', alpha: 0 };
        if (density < 0.62) return { ch: '░', alpha: 0.30 };
        if (density < 0.78) return { ch: '▒', alpha: 0.55 };
        return { ch: '▓', alpha: 0.78 };
      }
      case MODES.sunny: {
        // Subtle '.' heat haze
        const haze = fbm2(nx * 6 + T * 0.6, ny * 3 + T * 0.25, seed + 55, 4);
        const wave = Math.sin((nx * 10 + T * 1.2) + haze * 2);
        const p = (haze + 0.25 * (wave * 0.5 + 0.5));
        const frac = p - Math.floor(p);

        if (p > 0.62 && frac > 0.85) return { ch: '.', alpha: 0.35 };
        if (p > 0.70 && frac > 0.75) return { ch: '.', alpha: 0.25 };
        return { ch: '', alpha: 0 };
      }
      case MODES.night: {
        // Twinkling '.' stars
        const starField = fbm2(nx * 12 + seed, ny * 12 + seed, seed + 88, 4);
        // stars: mostly sparse
        const isStar = starField > 0.72;
        if (!isStar) return { ch: '', alpha: 0 };

        // Twinkle from time + noise
        const tw = fbm2(nx * 12 + T * 0.9, ny * 12 - T * 0.7, seed + 99, 3);
        const tw2 = fbm2(nx * 2 + T * 2.2, ny * 2, seed + 111, 2);
        const intensity = (tw * 0.6 + tw2 * 0.4);

        if (intensity > 0.68) return { ch: '.', alpha: 0.9 };
        if (intensity > 0.55) return { ch: '.', alpha: 0.55 };
        if (intensity > 0.45) return { ch: '.', alpha: 0.30 };
        return { ch: '', alpha: 0 };
      }
      default:
        return { ch: '', alpha: 0 };
    }
  }

  function frameRender() {
    if (!running) return;

    // Compute cells for this tick
    for (let i = 0; i < cols * rows; i++) {
      const { ch, alpha } = computeCell(i);
      const code = ch ? ch.charCodeAt(0) : 0;
      charCurr[i] = code;

      if (code !== charPrev[i]) {
        // Draw using alpha derived from compute
        drawDirtyCell(i, code, alpha);
        charPrev[i] = code;
      }
    }
  }

  function loop(now) {
    if (!running) return;

    const delta = now - lastReal;
    lastReal = now;

    // Cap accumulator to avoid spiral of death.
    acc = Math.min(acc + delta, STEP_MS * 4);

    while (acc >= STEP_MS) {
      t += STEP_MS / 1000;
      frameRender();
      acc -= STEP_MS;

      // If page hidden, avoid extra work.
      if (document.visibilityState !== 'visible') break;
    }

    requestAnimationFrame(loop);
  }

  function start() {
    resize();
    lastReal = performance.now();
    acc = 0;
    running = true;
    requestAnimationFrame(loop);
  }

  function pause() {
    running = false;
  }

  function resume() {
    running = true;
    lastReal = performance.now();
    acc = 0;
    // Force full redraw by clearing prev to different from curr
    // Re-render once to avoid stale chars.
    for (let i = 0; i < cols * rows; i++) charPrev[i] = 0;
    frameRender();
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => {
    // Debounce resize using rAF
    resize();
    // Force redraw on resize
    for (let i = 0; i < cols * rows; i++) charPrev[i] = 0;
    frameRender();
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pause();
    else resume();
  });

  // Start
  start();
})();

