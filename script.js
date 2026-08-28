// Register the service worker so the app shell works offline and Android
// recognizes the page as installable (Add to Home Screen / Install app).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {
      // Offline support just won't be available — the app still works online.
    });
  });
}

(() => {
  // ---------------------------------------------------------------------
  // Vector CAD-lite core.
  //
  // Everything drawn is a real object (mm coordinates, not baked pixels),
  // kept in `shapes` and redrawn every frame from a pan/zoom viewport
  // transform. This is what makes exact-length editing, selection, and a
  // real scale bar possible — and it's also the actual fix for a line not
  // landing under your finger: the old code mapped touch position through
  // a canvas.width/rect.width ratio on a canvas whose CSS size and pixel
  // size could drift apart. Coordinates now go through one standard
  // devicePixelRatio-normalized transform (resizeCanvas + clientToMm) —
  // one CSS pixel is always one ctx unit, full stop.
  // ---------------------------------------------------------------------
  const PAGE_SIZES = { A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 }, A2: { w: 420, h: 594 }, A1: { w: 594, h: 841 } };
  let pageKey = 'A4';
  function pageW() { return PAGE_SIZES[pageKey].w; }
  function pageH() { return PAGE_SIZES[pageKey].h; }
  const PALETTE = ['#1a1a1a', '#e63946', '#2a9d8f', '#264653', '#f4a261', '#8338ec'];
  const MIN_SCALE = 0.4, MAX_SCALE = 60; // screen px per mm
  const HIT_TOLERANCE_PX = 10;
  const PAN_START_THRESHOLD_PX = 5; // deadzone before an empty-area drag actually pans — stops tap jitter from "walking" the sheet

  const canvas = document.getElementById('drawCanvas');
  const ctx = canvas.getContext('2d');

  const view = { scale: 1, offsetX: 0, offsetY: 0 }; // offsetX/Y = screen-px position of mm-origin (0,0)

  // The canvas is now the whole screen (see style.css), so this fit IS the
  // real device screen size — rect.width/height come straight off the
  // fullscreen canvas element, in real CSS pixels for this device. A small
  // margin still keeps the drafting frame off the very edge (bezel/notch),
  // but the sheet otherwise fills as much of the actual screen as its
  // proportions allow.
  function fitPageToView() {
    const rect = canvas.getBoundingClientRect();
    const margin = 10;
    const availW = Math.max(50, rect.width - margin * 2);
    const availH = Math.max(50, rect.height - margin * 2);
    view.scale = Math.min(availW / pageW(), availH / pageH(), MAX_SCALE);
    view.offsetX = (rect.width - pageW() * view.scale) / 2;
    view.offsetY = (rect.height - pageH() * view.scale) / 2;
    requestRedraw();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // one ctx unit == one CSS pixel from here on
    requestRedraw();
  }

  function clientToPx(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function pxToMm(px) { return { x: (px.x - view.offsetX) / view.scale, y: (px.y - view.offsetY) / view.scale }; }
  function mmToPx(mm) { return { x: mm.x * view.scale + view.offsetX, y: mm.y * view.scale + view.offsetY }; }
  function clientToMm(clientX, clientY) { return pxToMm(clientToPx(clientX, clientY)); }

  function formatMm(v, decimals = 1) {
    const fixed = Math.abs(v) < 1e-9 ? (0).toFixed(decimals) : v.toFixed(decimals);
    return fixed.replace('.', ',');
  }
  function parseMm(str) {
    const v = parseFloat(String(str).replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }
  function niceMm(raw) {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const step of [1, 2, 5]) if (raw <= step * mag) return step * mag;
    return 10 * mag;
  }

  // ---------------------------------------------------------------------
  // Shapes — plain data, mm coordinates. Nothing is ever baked into
  // pixels, so anything can be selected, measured and re-edited later.
  // ---------------------------------------------------------------------
  let nextId = 1;
  let shapes = [];
  let selected = null;

  // ---------------------------------------------------------------------
  // Project — an optional "book of pages", each with its own shapes array.
  // With no project, the app behaves exactly as a single implicit sheet
  // always has (nothing below is engaged, `shapes` is just used directly).
  // Every place that reassigns `shapes` wholesale (clear, delete, erase, a
  // page switch) goes through setShapes() so the active page's array
  // inside `project` never drifts out of sync with what's actually on
  // screen — a plain `shapes = x` would silently orphan the old array.
  // ---------------------------------------------------------------------
  let project = null; // { name, pages: [{ number, shapes }] } | null
  let currentPageIndex = 0;

  function setShapes(newShapes) {
    shapes = newShapes;
    if (project) project.pages[currentPageIndex].shapes = shapes;
  }

  const KIND_LABELS = {
    line: 'Лінія', rect: 'Прямокутник', circle: 'Коло', arc: 'Дуга', leader: 'Виноска',
    freehand: 'Олівець', polyline: 'Полілінія', tilearea: 'Плитка (розкладка)',
  };

  function makePreviewShape(tool, x1, y1, x2, y2) {
    if (tool === 'line') return { type: 'line', x1, y1, x2, y2 };
    if (tool === 'rect') return { type: 'rect', x1, y1, x2, y2 };
    if (tool === 'circle') return { type: 'circle', cx: x1, cy: y1, r: Math.hypot(x2 - x1, y2 - y1) };
    if (tool === 'arc') return { type: 'arc', cx: x1, cy: y1, r: Math.hypot(x2 - x1, y2 - y1), startDeg: 0, endDeg: 360 };
    if (tool === 'leader') return { type: 'leader', x1, y1, x2, y2, text: '' };
    if (tool === 'tilearea') return { type: 'tilearea', x1, y1, x2, y2, tileW: 600, tileH: 1200, grout: 2, imageId: null };
    return null;
  }

  // ---------------------------------------------------------------------
  // ГОСТ-lite: material hatching for closed shapes (rect/circle) and a
  // leader/callout tool for feature labels ("що це за гвинт", etc).
  // Not a pixel-perfect reproduction of ГОСТ 2.306 — a practical, visually
  // distinct set covering the materials/labels a hand drawing needs.
  // ---------------------------------------------------------------------
  const HATCH_LIST = [
    { key: null, label: 'Немає' },
    { key: 'metal', label: 'Метал' },
    { key: 'wood', label: 'Дерево' },
    { key: 'concrete', label: 'Бетон' },
    { key: 'glass', label: 'Скло' },
    { key: 'insulation', label: 'Ізоляція' },
    { key: 'soil', label: 'Ґрунт' },
  ];

  function pseudoRandom01(gx, gy) {
    const v = Math.sin(gx * 12.9898 + gy * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  // Parallel lines through the bounding box at a given angle, spaced in
  // screen px — reused for every straight-line hatch style.
  function drawParallelLines(context, bounds, angleDeg, spacingPx) {
    const angle = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const nx = -dy, ny = dx;
    const cx = (bounds.x0 + bounds.x1) / 2, cy = (bounds.y0 + bounds.y1) / 2;
    const diag = Math.hypot(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) || 1;
    context.beginPath();
    for (let o = -diag; o <= diag; o += spacingPx) {
      const px = cx + nx * o, py = cy + ny * o;
      context.moveTo(px - dx * diag, py - dy * diag);
      context.lineTo(px + dx * diag, py + dy * diag);
    }
    context.stroke();
  }

  // Near-vertical lines with a slight wobble — suggests wood grain.
  function drawGrainLines(context, bounds, spacingPx) {
    const amp = Math.min(3, spacingPx * 0.25);
    for (let x = bounds.x0 + spacingPx / 2; x <= bounds.x1; x += spacingPx) {
      context.beginPath();
      context.moveTo(x, bounds.y0);
      const mid = (bounds.y0 + bounds.y1) / 2;
      context.quadraticCurveTo(x + amp, mid, x, bounds.y1);
      context.stroke();
    }
  }

  // Horizontal loop/wave rows — standard-ish thermal-insulation symbol.
  function drawWavyRows(context, bounds, spacingPx) {
    const amp = spacingPx * 0.35;
    for (let y = bounds.y0 + spacingPx / 2; y <= bounds.y1; y += spacingPx) {
      context.beginPath();
      let x = bounds.x0;
      context.moveTo(x, y);
      let up = true;
      while (x < bounds.x1) {
        const nx = Math.min(bounds.x1, x + amp * 2);
        context.quadraticCurveTo(x + amp, y + (up ? -amp : amp), nx, y);
        x = nx; up = !up;
      }
      context.stroke();
    }
  }

  function drawScatterDots(context, bounds, spacingPx, sizePx) {
    context.beginPath();
    for (let gy = 0; bounds.y0 + gy * spacingPx <= bounds.y1; gy++) {
      for (let gx = 0; bounds.x0 + gx * spacingPx <= bounds.x1; gx++) {
        const jx = pseudoRandom01(gx, gy), jy = pseudoRandom01(gx + 91, gy + 17);
        const x = bounds.x0 + gx * spacingPx + jx * spacingPx * 0.6;
        const y = bounds.y0 + gy * spacingPx + jy * spacingPx * 0.6;
        context.moveTo(x + sizePx, y);
        context.arc(x, y, sizePx, 0, Math.PI * 2);
      }
    }
    context.fill();
  }

  const HATCH_DEFS = {
    metal: (context, bounds) => {
      context.lineWidth = 1;
      drawParallelLines(context, bounds, 45, Math.max(3, 3 * view.scale));
    },
    wood: (context, bounds) => {
      context.lineWidth = 1;
      drawGrainLines(context, bounds, Math.max(4, 4 * view.scale));
    },
    concrete: (context, bounds) => {
      context.lineWidth = 1;
      const spacing = Math.max(4, 5 * view.scale);
      drawParallelLines(context, bounds, 45, spacing);
      drawParallelLines(context, bounds, 135, spacing);
      drawScatterDots(context, bounds, spacing, Math.max(1, 0.9 * view.scale));
    },
    glass: (context, bounds) => {
      context.lineWidth = 0.75;
      const spacing = Math.max(2.5, 2 * view.scale);
      drawParallelLines(context, bounds, 45, spacing);
      drawParallelLines(context, bounds, 135, spacing);
    },
    insulation: (context, bounds) => {
      context.lineWidth = 1;
      drawWavyRows(context, bounds, Math.max(5, 5 * view.scale));
    },
    soil: (context, bounds) => {
      context.lineWidth = 1;
      context.setLineDash([Math.max(2, 1.5 * view.scale), Math.max(2, 1.5 * view.scale)]);
      drawParallelLines(context, bounds, 45, Math.max(3, 3 * view.scale));
      context.setLineDash([]);
    },
  };

  function shapeHatchBounds(s) {
    if (s.type === 'rect') {
      const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
      return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    }
    if (s.type === 'circle') {
      const c = mmToPx({ x: s.cx, y: s.cy }), r = Math.max(0.01, s.r * view.scale);
      return { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r, circle: { cx: c.x, cy: c.y, r } };
    }
    return null;
  }

  function drawHatch(context, s) {
    if (!s.hatch || !HATCH_DEFS[s.hatch]) return;
    const bounds = shapeHatchBounds(s);
    if (!bounds) return;
    context.save();
    context.beginPath();
    if (bounds.circle) context.arc(bounds.circle.cx, bounds.circle.cy, bounds.circle.r, 0, Math.PI * 2);
    else context.rect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
    context.clip();
    context.strokeStyle = s.color;
    context.fillStyle = s.color;
    HATCH_DEFS[s.hatch](context, bounds, s);
    context.restore();
  }

  // ---------------------------------------------------------------------
  // Leader/callout: feature point -> elbow -> text shelf, ГОСТ-style.
  // ---------------------------------------------------------------------
  const LEADER_TEXT_HEIGHT_MM = 3.5;

  function leaderGeometry(s) {
    const p1 = mmToPx({ x: s.x1, y: s.y1 });
    const p2 = mmToPx({ x: s.x2, y: s.y2 });
    const fontPx = Math.max(9, LEADER_TEXT_HEIGHT_MM * view.scale);
    const text = s.text || '';
    ctx.font = `${fontPx}px "Segoe UI", Roboto, sans-serif`;
    const textW = text ? ctx.measureText(text).width : 0;
    const dir = p2.x >= p1.x ? 1 : -1;
    const shelfLen = Math.max(10, textW + 6);
    const p3 = { x: p2.x + dir * shelfLen, y: p2.y };
    const textX = dir === 1 ? p2.x + 4 : p3.x + 4;
    const textY = p2.y - 4;
    return { p1, p2, p3, fontPx, text, dir, textX, textY };
  }

  function drawLeader(context, s, isPreview) {
    const g = leaderGeometry(s);
    context.save();
    context.strokeStyle = s.color;
    context.fillStyle = s.color;
    context.lineWidth = Math.max(1, s.lineWidthMm * view.scale);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (isPreview) context.globalAlpha = 0.75;

    context.beginPath();
    context.moveTo(g.p1.x, g.p1.y);
    context.lineTo(g.p2.x, g.p2.y);
    context.lineTo(g.p3.x, g.p3.y);
    context.stroke();

    // Arrowhead pointing at the feature point.
    const ang = Math.atan2(g.p2.y - g.p1.y, g.p2.x - g.p1.x);
    const headLen = Math.max(6, 3 * view.scale);
    context.beginPath();
    context.moveTo(g.p1.x, g.p1.y);
    context.lineTo(g.p1.x + headLen * Math.cos(ang - 0.32), g.p1.y + headLen * Math.sin(ang - 0.32));
    context.lineTo(g.p1.x + headLen * Math.cos(ang + 0.32), g.p1.y + headLen * Math.sin(ang + 0.32));
    context.closePath();
    context.fill();

    if (g.text) {
      context.font = `${g.fontPx}px "Segoe UI", Roboto, sans-serif`;
      context.textBaseline = 'alphabetic';
      context.fillText(g.text, g.textX, g.textY);
    }
    context.globalAlpha = 1;
    context.restore();
  }

  // ---------------------------------------------------------------------
  // Tile planning: draw a room/wall area, define a tile size (+ an optional
  // photo texture picked from the phone gallery), get an automatic layout
  // showing how many tiles fit and what the pattern looks like — cut tiles
  // at the edges show a cropped slice of the photo, not a squished one.
  // ---------------------------------------------------------------------
  const tileImageCache = new Map(); // shape.id -> loaded HTMLImageElement (photos aren't serialized into shapes directly)

  function computeTileGrid(roomW, roomH, tileW, tileH, grout) {
    const stepW = tileW + grout, stepH = tileH + grout;
    const cols = [];
    for (let x = 0; x < roomW - 0.01; x += stepW) cols.push(x);
    const rows = [];
    for (let y = 0; y < roomH - 0.01; y += stepH) rows.push(y);
    const tiles = [];
    let fullCount = 0;
    for (const y of rows) {
      for (const x of cols) {
        const w = Math.min(tileW, roomW - x);
        const h = Math.min(tileH, roomH - y);
        const isFull = w >= tileW - 0.05 && h >= tileH - 0.05;
        if (isFull) fullCount++;
        tiles.push({ x, y, w, h, isFull });
      }
    }
    return { tiles, fullCount, partialCount: tiles.length - fullCount, total: tiles.length, cols: cols.length, rows: rows.length };
  }

  function tileAreaBounds(s) {
    const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  function drawTileArea(context, s, isPreview) {
    const roomW = Math.abs(s.x2 - s.x1), roomH = Math.abs(s.y2 - s.y1);
    const bounds = tileAreaBounds(s);
    const img = tileImageCache.get(s.id);

    context.save();
    if (isPreview) context.globalAlpha = 0.75;
    context.fillStyle = '#eceae4';
    context.fillRect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);

    if (roomW > 0 && roomH > 0) {
      context.beginPath();
      context.rect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
      context.clip();

      const grid = computeTileGrid(roomW, roomH, s.tileW, s.tileH, s.grout);
      const tileWpx = s.tileW * view.scale, tileHpx = s.tileH * view.scale;
      for (const t of grid.tiles) {
        const px = { x: bounds.x0 + t.x * view.scale, y: bounds.y0 + t.y * view.scale };
        const wpx = t.w * view.scale, hpx = t.h * view.scale;
        if (img && img.complete && img.naturalWidth) {
          // a cut edge tile shows a proportionally cropped slice of the
          // photo, not the whole image squeezed to fit — matches how a real
          // tile would actually be cut on-site.
          const srcW = img.naturalWidth * (t.w / s.tileW), srcH = img.naturalHeight * (t.h / s.tileH);
          context.drawImage(img, 0, 0, srcW, srcH, px.x, px.y, wpx, hpx);
        } else {
          context.fillStyle = t.isFull ? '#f5f3ee' : '#ece5d6';
          context.fillRect(px.x, px.y, wpx, hpx);
        }
        context.strokeStyle = 'rgba(40,36,28,0.35)';
        context.lineWidth = 1;
        context.strokeRect(px.x, px.y, wpx, hpx);
        if (!t.isFull) {
          // flag tiles that need cutting with a dashed accent border
          context.save();
          context.setLineDash([3, 3]);
          context.strokeStyle = '#c1121f';
          context.strokeRect(px.x + 1, px.y + 1, wpx - 2, hpx - 2);
          context.restore();
        }
      }
      context.restore(); // undo clip
      context.save();
      if (isPreview) context.globalAlpha = 0.75;
    }

    context.strokeStyle = s.color;
    context.lineWidth = Math.max(1, s.lineWidthMm * view.scale);
    context.strokeRect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
    context.globalAlpha = 1;
    context.restore();
  }

  function tileAreaSummary(s) {
    const roomW = Math.abs(s.x2 - s.x1), roomH = Math.abs(s.y2 - s.y1);
    if (roomW < 1 || roomH < 1) return 'Задайте розмір приміщення (потягніть за кут).';
    const grid = computeTileGrid(roomW, roomH, s.tileW, s.tileH, s.grout);
    const base = `${grid.cols}×${grid.rows} = ${grid.total} плиток`;
    return grid.partialCount
      ? `${base} (${grid.fullCount} цілих + ${grid.partialCount} із підрізкою)`
      : `${base} (усі цілі, без підрізки)`;
  }

  // ---------------------------------------------------------------------
  // "Скан малюнка" — photograph a hand sketch on paper, mark its 4 corners
  // (perspective correction), and get real editable line/polyline shapes
  // on the sheet instead of just a picture. Everything below is plain
  // pixel math done on a <canvas> — no external CV library, so it keeps
  // working fully offline like the rest of this PWA.
  //
  // Pipeline: 4-point homography straightens the photo -> grayscale ->
  // Otsu threshold (+ user sensitivity) makes a black/white "ink" mask ->
  // Zhang-Suen thinning reduces every stroke to a 1px-wide skeleton ->
  // walking the skeleton traces it into pixel chains -> Douglas-Peucker
  // simplifies each chain down to a handful of straight vertices, which
  // become ordinary 'line' (2 points) or 'polyline' (3+) shapes.
  // ---------------------------------------------------------------------

  // Solve the 3x3 homography H (as a flat row-major array of 9, H[8]=1)
  // mapping each `dstPts[i]` to `srcPts[i]`, via an 8x8 linear system
  // (the standard DLT formulation for a 4-point perspective transform).
  function solveLinearSystem(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      [M[col], M[piv]] = [M[piv], M[col]];
      const pivVal = M[col][col] || 1e-12;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col] / pivVal;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / (row[i] || 1e-12));
  }
  function solveHomography(dstPts, srcPts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = dstPts[i], { x: X, y: Y } = srcPts[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    const h = solveLinearSystem(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function applyHomography(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  }

  function sampleBilinear(imgData, x, y) {
    const w = imgData.width, h = imgData.height, d = imgData.data;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return [255, 255, 255];
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (xx, yy, c) => d[(yy * w + xx) * 4 + c];
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const top = at(x0, y0, c) + (at(x0 + 1, y0, c) - at(x0, y0, c)) * fx;
      const bot = at(x0, y0 + 1, c) + (at(x0 + 1, y0 + 1, c) - at(x0, y0 + 1, c)) * fx;
      out[c] = top + (bot - top) * fy;
    }
    return out;
  }

  // Un-warps the quadrilateral `srcCorners` (in srcCanvas pixel space) into
  // a clean outW×outH rectangle — the actual perspective correction step.
  function warpPerspective(srcCanvas, srcCorners, outW, outH) {
    const dstCorners = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
    const H = solveHomography(dstCorners, srcCorners); // maps a point in the OUTPUT to where it came from in the source
    const sctx = srcCanvas.getContext('2d');
    const sImg = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const octx = out.getContext('2d');
    const oImg = octx.createImageData(outW, outH);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const p = applyHomography(H, x + 0.5, y + 0.5);
        const [r, g, b] = sampleBilinear(sImg, p.x, p.y);
        const di = (y * outW + x) * 4;
        oImg.data[di] = r; oImg.data[di + 1] = g; oImg.data[di + 2] = b; oImg.data[di + 3] = 255;
      }
    }
    octx.putImageData(oImg, 0, 0);
    return out;
  }

  function toGrayscale(canvas) {
    const ctx2 = canvas.getContext('2d');
    const { data, width, height } = ctx2.getImageData(0, 0, canvas.width, canvas.height);
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return { gray, width, height };
  }

  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
    }
    return threshold;
  }

  // sensitivity in [0,1]: higher picks up fainter pencil marks (raises the
  // cutoff so more grayish pixels count as "ink" rather than paper).
  function binarize(gray, threshold, sensitivity) {
    const t = threshold + (sensitivity - 0.5) * 90;
    const bin = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] < t ? 1 : 0;
    return bin;
  }

  // Zhang-Suen thinning — reduces a blob of "ink" pixels to a 1px skeleton
  // while preserving connectivity, so each stroke becomes a traceable line.
  function zhangSuenThin(bin, w, h) {
    let img = bin.slice();
    const idx = (x, y) => y * w + x;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 60) {
      changed = false;
      for (const step of [0, 1]) {
        const toRemove = [];
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            if (!img[idx(x, y)]) continue;
            const p = [
              img[idx(x, y - 1)], img[idx(x + 1, y - 1)], img[idx(x + 1, y)], img[idx(x + 1, y + 1)],
              img[idx(x, y + 1)], img[idx(x - 1, y + 1)], img[idx(x - 1, y)], img[idx(x - 1, y - 1)],
            ]; // N, NE, E, SE, S, SW, W, NW
            const B = p.reduce((a, v) => a + v, 0);
            if (B < 2 || B > 6) continue;
            let A = 0;
            for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) A++;
            if (A !== 1) continue;
            if (step === 0) {
              if (p[0] * p[2] * p[4] !== 0) continue;
              if (p[2] * p[4] * p[6] !== 0) continue;
            } else {
              if (p[0] * p[2] * p[6] !== 0) continue;
              if (p[0] * p[4] * p[6] !== 0) continue;
            }
            toRemove.push(idx(x, y));
          }
        }
        if (toRemove.length) { changed = true; for (const i of toRemove) img[i] = 0; }
      }
    }
    return img;
  }

  // Walks the skeleton into pixel chains (a simple greedy tracer — good
  // enough for "recognize the clear lines of a sketch", not a full
  // topology solver for every crossing).
  function traceSkeleton(bin, w, h) {
    const pixels = new Set();
    for (let i = 0; i < bin.length; i++) if (bin[i]) pixels.add(i);
    const neighborsOf = (i) => {
      const x = i % w, y = (i / w) | 0, out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (pixels.has(ni)) out.push(ni);
      }
      return out;
    };
    const visitedEdges = new Set();
    const edgeKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

    function walkFrom(start) {
      const path = [start];
      let current = start, prev = null;
      for (;;) {
        const neigh = neighborsOf(current).filter((n) => n !== prev && !visitedEdges.has(edgeKey(current, n)));
        if (!neigh.length) break;
        let next = neigh[0];
        if (neigh.length > 1 && prev !== null) {
          const px = prev % w, py = (prev / w) | 0, cx = current % w, cy = (current / w) | 0;
          const dirX = cx - px, dirY = cy - py;
          let best = -Infinity;
          for (const n of neigh) {
            const nx = n % w, ny = (n / w) | 0;
            const score = (nx - cx) * dirX + (ny - cy) * dirY;
            if (score > best) { best = score; next = n; }
          }
        }
        visitedEdges.add(edgeKey(current, next));
        path.push(next);
        prev = current; current = next;
      }
      return path;
    }

    const degree = new Map();
    for (const i of pixels) degree.set(i, neighborsOf(i).length);
    const endpoints = [...pixels].filter((i) => degree.get(i) === 1);
    const paths = [];
    for (const start of [...endpoints, ...pixels]) {
      const hasFreeEdge = neighborsOf(start).some((n) => !visitedEdges.has(edgeKey(start, n)));
      if (!hasFreeEdge) continue;
      const path = walkFrom(start);
      if (path.length >= 2) paths.push(path);
    }
    return paths.map((path) => path.map((i) => ({ x: i % w, y: (i / w) | 0 })));
  }

  function perpendicularDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  }
  function simplifyRDP(points, epsilon) {
    if (points.length < 3) return points;
    let maxDist = 0, index = 0;
    const first = points[0], last = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = perpendicularDistance(points[i], first, last);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > epsilon) {
      const left = simplifyRDP(points.slice(0, index + 1), epsilon);
      const right = simplifyRDP(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  function pathLengthPx(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return len;
  }

  const SCAN_MAX_SHAPES = 400;
  const SCAN_MIN_PATH_PX = 14; // discard specks/noise shorter than this

  // 'Вирівняти лінії' — optional cleanup after tracing: merges consecutive
  // segments that are nearly the same direction (removes the stair-step
  // jitter a raw skeleton trace has even after RDP simplification), snaps
  // any segment already close to a common drafting angle (0/45/90/135°) to
  // exactly that angle, and finally collapses a path that ends up nearly
  // straight end-to-end into a true 2-point line. This is what turns "a
  // traced photo" into "a clean drawing" — off, you get the literal traced
  // skeleton, wobble included.
  const STRAIGHTEN_COLINEAR_DEG = 6;      // merge segments whose direction differs by less than this
  const STRAIGHTEN_SNAP_DEG = 4;          // snap a segment within this many degrees of a "nice" angle
  const STRAIGHTEN_COLLAPSE_RATIO = 0.01; // collapse to one line if max deviation < 1% of its length

  function segAngleDeg(a, b) { return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI; }
  function angleDiffDeg(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  function pathMaxDeviationPx(points) {
    const first = points[0], last = points[points.length - 1];
    let max = 0;
    for (let i = 1; i < points.length - 1; i++) max = Math.max(max, perpendicularDistance(points[i], first, last));
    return max;
  }

  function straightenPath(points) {
    if (points.length < 3) return points;

    // 1. merge consecutive near-colinear segments
    const merged = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const a = merged[merged.length - 1], b = points[i], c = points[i + 1];
      if (angleDiffDeg(segAngleDeg(a, b), segAngleDeg(b, c)) > STRAIGHTEN_COLINEAR_DEG) merged.push(b);
    }
    merged.push(points[points.length - 1]);

    // 2. snap each remaining segment to the nearest 45° step when close
    const snapped = [merged[0]];
    for (let i = 1; i < merged.length; i++) {
      const a = snapped[snapped.length - 1], b = merged[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = segAngleDeg(a, b);
      const nice = Math.round(ang / 45) * 45;
      if (angleDiffDeg(ang, nice) <= STRAIGHTEN_SNAP_DEG) {
        const rad = (nice * Math.PI) / 180;
        snapped.push({ x: a.x + Math.cos(rad) * len, y: a.y + Math.sin(rad) * len });
      } else {
        snapped.push(b);
      }
    }

    // 3. a path that ends up nearly straight end-to-end collapses to one line
    if (snapped.length > 2) {
      const straightLen = pathLengthPx([snapped[0], snapped[snapped.length - 1]]);
      if (straightLen > 0 && pathMaxDeviationPx(snapped) < straightLen * STRAIGHTEN_COLLAPSE_RATIO) {
        return [snapped[0], snapped[snapped.length - 1]];
      }
    }
    return snapped;
  }

  // The full pipeline, from a straightened photo canvas to ready-to-use
  // mm-space line/polyline shape data. Kept separate from any DOM/UI so it
  // can run against a synthetic canvas in tests, not just a real photo.
  function runScanPipeline(correctedCanvas, sensitivity, mmW, mmH, offsetXmm, offsetYmm, straighten = true) {
    const { gray, width, height } = toGrayscale(correctedCanvas);
    const threshold = otsuThreshold(gray);
    const bin = binarize(gray, threshold, sensitivity);
    const thinned = zhangSuenThin(bin, width, height);
    const rawPaths = traceSkeleton(thinned, width, height);
    const epsilon = Math.max(1.2, Math.min(width, height) * 0.003);
    let simplified = rawPaths
      .map((p) => simplifyRDP(p, epsilon))
      .map((p) => (straighten ? straightenPath(p) : p))
      .filter((p) => p.length >= 2 && pathLengthPx(p) >= SCAN_MIN_PATH_PX);
    simplified.sort((a, b) => pathLengthPx(b) - pathLengthPx(a));
    const dropped = Math.max(0, simplified.length - SCAN_MAX_SHAPES);
    simplified = simplified.slice(0, SCAN_MAX_SHAPES);

    const sx = mmW / width, sy = mmH / height;
    const toMm = (p) => ({ x: p.x * sx + offsetXmm, y: p.y * sy + offsetYmm });
    const newShapes = simplified.map((p) => {
      const pts = p.map(toMm);
      const base = { color: state.color, lineWidthMm: 0.4, id: nextId++ };
      return pts.length === 2
        ? { type: 'line', x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, ...base }
        : { type: 'polyline', points: pts, ...base };
    });
    return { shapes: newShapes, dropped, threshold };
  }

  function renderOneShape(context, s, isPreview) {
    if (s.type === 'leader') { drawLeader(context, s, isPreview); return; }
    if (s.type === 'tilearea') { drawTileArea(context, s, isPreview); return; }
    drawHatch(context, s);
    drawShape(context, s, isPreview);
  }

  function shapeLengthMm(s) { return s.type === 'line' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) : 0; }

  function drawShapePath(context, s) {
    if (s.type === 'line') {
      const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
    } else if (s.type === 'rect') {
      const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
      context.beginPath(); context.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.type === 'circle') {
      const c = mmToPx({ x: s.cx, y: s.cy });
      context.beginPath(); context.arc(c.x, c.y, Math.max(0.01, s.r * view.scale), 0, Math.PI * 2);
    } else if (s.type === 'arc') {
      const c = mmToPx({ x: s.cx, y: s.cy });
      const a0 = (s.startDeg * Math.PI) / 180, a1 = (s.endDeg * Math.PI) / 180;
      context.beginPath(); context.arc(c.x, c.y, Math.max(0.01, s.r * view.scale), a0, a1);
    } else if (s.type === 'freehand' || s.type === 'polyline') {
      const pts = s.points.map(mmToPx);
      context.beginPath();
      if (pts.length) {
        context.moveTo(pts[0].x, pts[0].y);
        if (s.type === 'freehand') {
          // smooth the raw pointer path through midpoints — lets one stroke
          // read as a clean curve or a clean straight line, whichever the
          // hand actually drew, instead of a jagged point-to-point trace.
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
            context.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
          }
          if (pts.length > 1) context.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        } else {
          for (let i = 1; i < pts.length; i++) context.lineTo(pts[i].x, pts[i].y);
        }
      }
    }
  }

  function drawShape(context, s, isPreview) {
    context.strokeStyle = s.color;
    context.lineWidth = Math.max(1, s.lineWidthMm * view.scale);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (isPreview) context.globalAlpha = 0.75;
    drawShapePath(context, s);
    context.stroke();
    context.globalAlpha = 1;
  }

  // Hit-test in SCREEN pixels (so the tolerance feels the same at any zoom).
  function hitTest(clientX, clientY) {
    const p = clientToPx(clientX, clientY);
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === 'line') {
        const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
        if (distToSegment(p, a, b) <= HIT_TOLERANCE_PX + s.lineWidthMm * view.scale / 2) return s;
      } else if (s.type === 'rect') {
        const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        const onEdge = Math.abs(p.x - x0) <= HIT_TOLERANCE_PX || Math.abs(p.x - x1) <= HIT_TOLERANCE_PX || Math.abs(p.y - y0) <= HIT_TOLERANCE_PX || Math.abs(p.y - y1) <= HIT_TOLERANCE_PX;
        const within = p.x >= x0 - HIT_TOLERANCE_PX && p.x <= x1 + HIT_TOLERANCE_PX && p.y >= y0 - HIT_TOLERANCE_PX && p.y <= y1 + HIT_TOLERANCE_PX;
        if (within && onEdge) return s;
      } else if (s.type === 'circle' || s.type === 'arc') {
        const c = mmToPx({ x: s.cx, y: s.cy });
        const dist = Math.hypot(p.x - c.x, p.y - c.y);
        if (Math.abs(dist - s.r * view.scale) <= HIT_TOLERANCE_PX + s.lineWidthMm * view.scale / 2) return s;
      } else if (s.type === 'leader') {
        const g = leaderGeometry(s);
        if (Math.min(distToSegment(p, g.p1, g.p2), distToSegment(p, g.p2, g.p3)) <= HIT_TOLERANCE_PX) return s;
      } else if (s.type === 'freehand' || s.type === 'polyline') {
        const pts = s.points.map(mmToPx);
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSegment(p, pts[i], pts[i + 1]) <= HIT_TOLERANCE_PX + s.lineWidthMm * view.scale / 2) return s;
        }
      } else if (s.type === 'tilearea') {
        // a filled area, unlike an empty rect — tap anywhere inside selects it
        const b = tileAreaBounds(s);
        if (p.x >= b.x0 - HIT_TOLERANCE_PX && p.x <= b.x1 + HIT_TOLERANCE_PX && p.y >= b.y0 - HIT_TOLERANCE_PX && p.y <= b.y1 + HIT_TOLERANCE_PX) return s;
      }
    }
    return null;
  }
  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // ---------------------------------------------------------------------
  // Render loop — rAF-throttled so a burst of pointermove events (common
  // on touch digitizers) can't force more redraws than the display can
  // show; this was the other half of the "jittery" complaint.
  // ---------------------------------------------------------------------
  let needsRedraw = true;
  function requestRedraw() { needsRedraw = true; }

  function render() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#dedad0';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // page
    const pTL = mmToPx({ x: 0, y: 0 }), pBR = mmToPx({ x: pageW(), y: pageH() });
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(pTL.x, pTL.y, pBR.x - pTL.x, pBR.y - pTL.y);
    ctx.restore();

    drawSheetFrame(ctx, pTL, pBR);

    for (const s of shapes) renderOneShape(ctx, s, false);
    if (dragPreview) renderOneShape(ctx, dragPreview, true);
    drawPolylineDraft(ctx);

    if (selected) {
      ctx.save();
      ctx.strokeStyle = '#8338ec';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      const pad = 4;
      if (selected.type === 'line' || selected.type === 'rect' || selected.type === 'tilearea') {
        const a = mmToPx({ x: selected.x1, y: selected.y1 }), b = mmToPx({ x: selected.x2, y: selected.y2 });
        ctx.strokeRect(Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad, Math.abs(b.x - a.x) + pad * 2, Math.abs(b.y - a.y) + pad * 2);
      } else if (selected.type === 'circle' || selected.type === 'arc') {
        const c = mmToPx({ x: selected.cx, y: selected.cy });
        ctx.beginPath(); ctx.arc(c.x, c.y, selected.r * view.scale + pad, 0, Math.PI * 2); ctx.stroke();
      } else if (selected.type === 'leader') {
        const g = leaderGeometry(selected);
        const xs = [g.p1.x, g.p2.x, g.p3.x], ys = [g.p1.y, g.p2.y, g.p3.y];
        const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      } else if (selected.type === 'freehand' || selected.type === 'polyline') {
        const pts = selected.points.map(mmToPx);
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
      ctx.restore();
    }

    updateScaleBar();
    needsRedraw = false;
  }

  function frame() {
    requestAnimationFrame(frame);
    if (needsRedraw) render();
  }

  // Sheet border: a real drafting frame (ГОСТ-style — wider margin on the
  // left for binding) instead of a decorative grid.
  function drawSheetFrame(context, pTL, pBR) {
    context.save();
    context.strokeStyle = 'rgba(0,0,0,0.35)';
    context.lineWidth = 1;
    context.strokeRect(pTL.x, pTL.y, pBR.x - pTL.x, pBR.y - pTL.y);
    context.beginPath();
    context.rect(pTL.x, pTL.y, pBR.x - pTL.x, pBR.y - pTL.y);
    context.clip();
    const inset = { left: 20, top: 5, right: 5, bottom: 5 };
    const a = mmToPx({ x: inset.left, y: inset.top });
    const b = mmToPx({ x: pageW() - inset.right, y: pageH() - inset.bottom });
    context.strokeStyle = 'rgba(20,20,20,0.6)';
    context.lineWidth = Math.max(1, 0.5 * view.scale);
    context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    context.restore();
  }

  // Live preview of a полілінія (chain-of-segments) being built: fixed
  // vertices + the segment currently being dragged into place.
  function drawPolylineDraft(context) {
    if (!polylineDraft) return;
    const pts = polylineDraft.points.map(mmToPx);
    context.save();
    context.strokeStyle = state.color;
    context.fillStyle = state.color;
    context.lineWidth = Math.max(1, state.lineWidthMm * view.scale);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (pts.length) {
      context.beginPath();
      context.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) context.lineTo(pts[i].x, pts[i].y);
      context.stroke();
    }
    pts.forEach((pt) => { context.beginPath(); context.arc(pt.x, pt.y, 3, 0, Math.PI * 2); context.fill(); });
    if (polylineDraft.previewEnd && pts.length) {
      const endPx = mmToPx(polylineDraft.previewEnd);
      context.globalAlpha = 0.7;
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      context.lineTo(endPx.x, endPx.y);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    context.restore();
  }

  // ---------------------------------------------------------------------
  // Scale bar (top-right HUD, same "nice number" idea as the 3D mode)
  // ---------------------------------------------------------------------
  const scaleBarFillEl = document.getElementById('scaleBarFill2d');
  const scaleBarLabelEl = document.getElementById('scaleBarLabel2d');
  function updateScaleBar() {
    if (!scaleBarFillEl) return;
    const targetPx = 80;
    const mm = niceMm(targetPx / view.scale);
    scaleBarFillEl.style.width = `${(mm * view.scale).toFixed(1)}px`;
    scaleBarLabelEl.textContent = `${formatMm(mm, 0)} мм`;
  }

  // ---------------------------------------------------------------------
  // Tools / project drawers — both hidden until their own edge button is
  // tapped, both fixed overlays that never resize the canvas underneath.
  // ---------------------------------------------------------------------
  const toolsDrawerEl = document.getElementById('toolsDrawer');
  const projectDrawerEl = document.getElementById('projectDrawer');
  const drawerBackdropEl = document.getElementById('drawerBackdrop');

  function openDrawer(el) {
    toolsDrawerEl.classList.toggle('open', el === toolsDrawerEl);
    projectDrawerEl.classList.toggle('open', el === projectDrawerEl);
    drawerBackdropEl.classList.remove('hidden');
  }
  function closeDrawers() {
    toolsDrawerEl.classList.remove('open');
    projectDrawerEl.classList.remove('open');
    drawerBackdropEl.classList.add('hidden');
  }

  document.getElementById('toolsFabBtn').addEventListener('click', () => openDrawer(toolsDrawerEl));
  document.getElementById('toolsDrawerClose').addEventListener('click', closeDrawers);
  document.getElementById('projectFabBtn').addEventListener('click', () => { renderProjectPanel(); openDrawer(projectDrawerEl); });
  document.getElementById('projectDrawerClose').addEventListener('click', closeDrawers);
  drawerBackdropEl.addEventListener('click', closeDrawers);

  // ---------------------------------------------------------------------
  // Project — "Створити проект" names it and starts page 1 from whatever's
  // already on the sheet; "+" appends an auto-numbered page; the number
  // field jumps straight to any page, however far into the book.
  // ---------------------------------------------------------------------
  function createProject(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    project = { name: trimmed, pages: [{ number: 1, shapes }] };
    currentPageIndex = 0;
    deselect();
    renderProjectPanel();
  }

  function addPage() {
    if (!project) return;
    const number = project.pages.length + 1;
    project.pages.push({ number, shapes: [] });
    switchToPage(project.pages.length - 1);
    renderProjectPanel();
  }

  function switchToPage(index) {
    if (!project || !project.pages[index]) return;
    if (polylineDraft) cancelPolyline();
    currentPageIndex = index;
    setShapes(project.pages[index].shapes);
    deselect();
    fitPageToView();
    renderProjectPanel();
  }

  function goToPageNumber(num) {
    if (!project) return;
    const idx = project.pages.findIndex((p) => p.number === num);
    if (idx === -1) { flashHint(`Сторінки № ${num} не існує`); return; }
    switchToPage(idx);
  }

  function renderProjectPanel() {
    const body = document.getElementById('projectDrawerBody');
    body.innerHTML = '';

    if (!project) {
      const group = document.createElement('div');
      group.className = 'tool-group';
      const h = document.createElement('h2'); h.textContent = 'Новий проект'; group.appendChild(h);

      const field = document.createElement('div'); field.className = 'project-field';
      const label = document.createElement('label'); label.htmlFor = 'projectNameInput'; label.textContent = 'Назва проекту';
      const input = document.createElement('input'); input.type = 'text'; input.id = 'projectNameInput';
      input.placeholder = 'Наприклад, Дизайн гаража';
      field.appendChild(label); field.appendChild(input);
      group.appendChild(field);

      const createBtn = document.createElement('button');
      createBtn.className = 'action-btn'; createBtn.textContent = '➕ Створити проект';
      const submit = () => createProject(input.value);
      createBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      group.appendChild(createBtn);
      body.appendChild(group);

      const hint = document.createElement('p');
      hint.className = 'hint-text';
      hint.textContent = 'Без проекту застосунок працює як один аркуш. Проект дозволяє тримати кілька пронумерованих сторінок в одній роботі — як книжку.';
      body.appendChild(hint);
      return;
    }

    const infoGroup = document.createElement('div'); infoGroup.className = 'tool-group';
    const name = document.createElement('p'); name.className = 'project-name'; name.textContent = project.name;
    const status = document.createElement('p'); status.className = 'hint-text';
    status.textContent = `Сторінка ${project.pages[currentPageIndex].number} із ${project.pages.length}`;
    const addBtn = document.createElement('button'); addBtn.className = 'action-btn'; addBtn.textContent = '➕ Додати сторінку';
    addBtn.addEventListener('click', addPage);
    infoGroup.appendChild(name); infoGroup.appendChild(status); infoGroup.appendChild(addBtn);
    body.appendChild(infoGroup);

    const jumpGroup = document.createElement('div'); jumpGroup.className = 'tool-group';
    const jh = document.createElement('h2'); jh.textContent = 'Перейти на сторінку'; jumpGroup.appendChild(jh);
    const jumpRow = document.createElement('div'); jumpRow.className = 'project-jump-row';
    const jumpInput = document.createElement('input'); jumpInput.type = 'number'; jumpInput.min = '1';
    jumpInput.placeholder = `1–${project.pages.length}`;
    const jumpBtn = document.createElement('button'); jumpBtn.textContent = 'Перейти';
    const jump = () => { const n = parseInt(jumpInput.value, 10); if (Number.isFinite(n)) goToPageNumber(n); };
    jumpBtn.addEventListener('click', jump);
    jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });
    jumpRow.appendChild(jumpInput); jumpRow.appendChild(jumpBtn);
    jumpGroup.appendChild(jumpRow);
    body.appendChild(jumpGroup);

    const listGroup = document.createElement('div'); listGroup.className = 'tool-group';
    const lh = document.createElement('h2'); lh.textContent = 'Сторінки'; listGroup.appendChild(lh);
    const list = document.createElement('div'); list.className = 'page-list';
    project.pages.forEach((page, idx) => {
      const btn = document.createElement('button');
      btn.className = 'page-list-btn' + (idx === currentPageIndex ? ' active' : '');
      const numSpan = document.createElement('span'); numSpan.className = 'page-list-num'; numSpan.textContent = `№ ${page.number}`;
      const countSpan = document.createElement('span'); countSpan.textContent = `${page.shapes.length} об’єкт(ів)`;
      btn.appendChild(numSpan); btn.appendChild(countSpan);
      btn.addEventListener('click', () => switchToPage(idx));
      list.appendChild(btn);
    });
    listGroup.appendChild(list);
    body.appendChild(listGroup);
  }

  // ---------------------------------------------------------------------
  // Tool state
  // ---------------------------------------------------------------------
  const state = { tool: 'select', color: '#1a1a1a', lineWidthMm: 0.8 };
  let dragPreview = null; // shape being drawn right now, or null

  const toolButtons = document.querySelectorAll('.tool-btn');
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (polylineDraft && btn.dataset.tool !== 'polyline') finishPolyline();
      toolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
      if (state.tool !== 'select') deselect();
      // Picking a tool is the signal to get out of the way again — see the
      // "toolbar isn't permanently expanded" requirement.
      closeDrawers();
    });
  });

  // ---------------------------------------------------------------------
  // Sheet format — А4/А3/А2/А1. Changing it re-fits the page in view and
  // is what the print function targets, so a drawing made on an А4 sheet
  // always comes out of the printer as А4, not whatever paper is loaded.
  // ---------------------------------------------------------------------
  const pageSizeButtons = document.querySelectorAll('.page-size-btn');
  pageSizeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      pageSizeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      pageKey = btn.dataset.pageSize;
      fitPageToView();
    });
  });

  const colorSwatches = document.querySelectorAll('.color-swatch');
  const customColor = document.getElementById('customColor');
  colorSwatches.forEach((sw) => {
    sw.addEventListener('click', () => {
      colorSwatches.forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      state.color = sw.dataset.color;
      customColor.value = sw.dataset.color;
      if (selected) { selected.color = state.color; requestRedraw(); }
    });
  });
  customColor.addEventListener('input', () => {
    colorSwatches.forEach((s) => s.classList.remove('active'));
    state.color = customColor.value;
    if (selected) { selected.color = state.color; requestRedraw(); }
  });

  const lineWidthInput = document.getElementById('lineWidth');
  const lineWidthValue = document.getElementById('lineWidthValue');
  lineWidthInput.addEventListener('input', () => {
    state.lineWidthMm = Number(lineWidthInput.value) / 10; // slider is in 0.1mm steps
    lineWidthValue.textContent = `${formatMm(state.lineWidthMm)} мм`;
    if (selected) { selected.lineWidthMm = state.lineWidthMm; requestRedraw(); }
  });

  // Photo-as-tile-texture: one shared hidden file input, retargeted per tile
  // area via a data attribute set right before it's opened.
  const tilePhotoInput = document.getElementById('tilePhotoInput');
  tilePhotoInput.addEventListener('change', () => {
    const file = tilePhotoInput.files[0];
    const targetId = Number(tilePhotoInput.dataset.targetId);
    tilePhotoInput.value = '';
    if (!file || !targetId) return;
    const shape = shapes.find((s) => s.id === targetId);
    if (!shape) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        tileImageCache.set(shape.id, img);
        requestRedraw();
        if (selected === shape) renderDimPanel();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // Brief transient toast over the sheet — used for scan-pipeline status,
  // page-jump errors, etc. Invisible and empty until called, so it never
  // takes up permanent screen space the way the old persistent hint bar did.
  const canvasHintEl = document.getElementById('canvasHint');
  let hintTimer = null;
  function flashHint(msg, ms = 4000) {
    if (!canvasHintEl) return;
    canvasHintEl.textContent = msg;
    canvasHintEl.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { canvasHintEl.classList.remove('show'); }, ms);
  }

  // -----------------------------------------------------------------------
  // "Скан малюнка" modal wiring — pick a photo, drag its 4 corners onto the
  // paper's actual corners, tune sensitivity against a live preview, commit.
  // -----------------------------------------------------------------------
  const scanModal = document.getElementById('scanModal');
  const scanPhotoInput = document.getElementById('scanPhotoInput');
  const scanPhotoCanvas = document.getElementById('scanPhotoCanvas');
  const scanPreviewCanvas = document.getElementById('scanPreviewCanvas');
  const scanSensitivityInput = document.getElementById('scanSensitivity');
  const scanStraightenInput = document.getElementById('scanStraighten');
  const scanStatusEl = document.getElementById('scanStatus');

  let scanState = null; // { img, fullCanvas, dispW, dispH, corners: [{x,y}x4] }
  let scanDraggingCorner = -1;

  function scanCanvasPoint(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function openScanModal(img) {
    // A working display resolution for the corner-picking canvas — capped
    // so dragging stays smooth regardless of the photo's real megapixels.
    const maxDim = 480;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const dispW = Math.round(img.naturalWidth * scale), dispH = Math.round(img.naturalHeight * scale);
    scanPhotoCanvas.width = dispW; scanPhotoCanvas.height = dispH;

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = img.naturalWidth; fullCanvas.height = img.naturalHeight;
    fullCanvas.getContext('2d').drawImage(img, 0, 0);

    const insetX = dispW * 0.12, insetY = dispH * 0.12;
    scanState = {
      img, fullCanvas, dispW, dispH,
      corners: [
        { x: insetX, y: insetY }, { x: dispW - insetX, y: insetY },
        { x: dispW - insetX, y: dispH - insetY }, { x: insetX, y: dispH - insetY },
      ],
    };
    scanSensitivityInput.value = 50;
    scanStatusEl.textContent = '';
    scanModal.classList.remove('hidden');
    redrawScanPhoto();
    updateScanPreview();
  }

  function closeScanModal() {
    scanModal.classList.add('hidden');
    scanState = null;
    scanDraggingCorner = -1;
  }

  function redrawScanPhoto() {
    if (!scanState) return;
    const ctx2 = scanPhotoCanvas.getContext('2d');
    ctx2.clearRect(0, 0, scanState.dispW, scanState.dispH);
    ctx2.drawImage(scanState.img, 0, 0, scanState.dispW, scanState.dispH);
    const c = scanState.corners;
    ctx2.save();
    ctx2.strokeStyle = '#8338ec';
    ctx2.lineWidth = 2;
    ctx2.setLineDash([6, 4]);
    ctx2.beginPath();
    ctx2.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx2.lineTo(c[i].x, c[i].y);
    ctx2.closePath();
    ctx2.stroke();
    ctx2.setLineDash([]);
    ctx2.fillStyle = '#ffffff';
    for (const p of c) {
      ctx2.beginPath(); ctx2.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx2.fill();
      ctx2.beginPath(); ctx2.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx2.stroke();
      ctx2.fillStyle = '#8338ec';
      ctx2.beginPath(); ctx2.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx2.fill();
      ctx2.fillStyle = '#ffffff';
    }
    ctx2.restore();
  }

  // Cheap-ish live preview: warp at a small working resolution and just
  // threshold (skip thinning/tracing, which only need to run once on commit).
  function updateScanPreview() {
    if (!scanState) return;
    const previewW = 220, previewH = 310;
    const fullScale = scanState.img.naturalWidth / scanState.dispW;
    const srcCorners = scanState.corners.map((p) => ({ x: p.x * fullScale, y: p.y * fullScale }));
    const corrected = warpPerspective(scanState.fullCanvas, srcCorners, previewW, previewH);
    const { gray, width, height } = toGrayscale(corrected);
    const threshold = otsuThreshold(gray);
    const sensitivity = Number(scanSensitivityInput.value) / 100;
    const bin = binarize(gray, threshold, sensitivity);
    scanPreviewCanvas.width = width; scanPreviewCanvas.height = height;
    const pctx = scanPreviewCanvas.getContext('2d');
    const out = pctx.createImageData(width, height);
    for (let i = 0; i < bin.length; i++) {
      const v = bin[i] ? 0 : 255;
      out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
    }
    pctx.putImageData(out, 0, 0);
  }

  scanPhotoCanvas.addEventListener('pointerdown', (e) => {
    if (!scanState) return;
    const p = scanCanvasPoint(scanPhotoCanvas, e.clientX, e.clientY);
    let best = -1, bestDist = 26; // px tolerance in canvas-internal units
    scanState.corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    scanDraggingCorner = best;
    scanPhotoCanvas.setPointerCapture(e.pointerId);
  });
  scanPhotoCanvas.addEventListener('pointermove', (e) => {
    if (!scanState || scanDraggingCorner < 0) return;
    const p = scanCanvasPoint(scanPhotoCanvas, e.clientX, e.clientY);
    scanState.corners[scanDraggingCorner] = {
      x: Math.max(0, Math.min(scanState.dispW, p.x)),
      y: Math.max(0, Math.min(scanState.dispH, p.y)),
    };
    redrawScanPhoto();
  });
  function endScanDrag() {
    if (scanDraggingCorner >= 0) { scanDraggingCorner = -1; updateScanPreview(); }
  }
  scanPhotoCanvas.addEventListener('pointerup', endScanDrag);
  scanPhotoCanvas.addEventListener('pointercancel', endScanDrag);

  scanSensitivityInput.addEventListener('input', updateScanPreview);

  document.getElementById('scanBtn').addEventListener('click', () => scanPhotoInput.click());
  scanPhotoInput.addEventListener('change', () => {
    const file = scanPhotoInput.files[0];
    scanPhotoInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => openScanModal(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('scanCancelBtn').addEventListener('click', closeScanModal);
  document.getElementById('scanCloseBtn').addEventListener('click', closeScanModal);

  document.getElementById('scanCommitBtn').addEventListener('click', () => {
    if (!scanState) return;
    scanStatusEl.textContent = 'Обробка…';
    // let the "Обробка…" message actually paint before the (synchronous,
    // CPU-heavy) pipeline blocks the main thread.
    setTimeout(() => {
      const fullScale = scanState.img.naturalWidth / scanState.dispW;
      const srcCorners = scanState.corners.map((p) => ({ x: p.x * fullScale, y: p.y * fullScale }));

      // Orientation follows the shape the user actually traced onto the
      // photo — a wide quad means the sheet was photographed sideways.
      const avgW = (Math.hypot(srcCorners[1].x - srcCorners[0].x, srcCorners[1].y - srcCorners[0].y)
        + Math.hypot(srcCorners[2].x - srcCorners[3].x, srcCorners[2].y - srcCorners[3].y)) / 2;
      const avgH = (Math.hypot(srcCorners[3].x - srcCorners[0].x, srcCorners[3].y - srcCorners[0].y)
        + Math.hypot(srcCorners[2].x - srcCorners[1].x, srcCorners[2].y - srcCorners[1].y)) / 2;
      const landscape = avgW > avgH;
      const mmW = landscape ? 297 : 210, mmH = landscape ? 210 : 297;

      const workingLong = 900;
      const pxW = landscape ? workingLong : Math.round(workingLong * (mmW / mmH));
      const pxH = landscape ? Math.round(workingLong * (mmH / mmW)) : workingLong;

      const corrected = warpPerspective(scanState.fullCanvas, srcCorners, pxW, pxH);
      const sensitivity = Number(scanSensitivityInput.value) / 100;
      const straighten = scanStraightenInput ? scanStraightenInput.checked : true;
      const offsetX = Math.max(0, (pageW() - mmW) / 2), offsetY = Math.max(0, (pageH() - mmH) / 2);
      const { shapes: newShapes, dropped } = runScanPipeline(corrected, sensitivity, mmW, mmH, offsetX, offsetY, straighten);

      shapes.push(...newShapes);
      requestRedraw();
      closeScanModal();
      flashHint(
        newShapes.length
          ? `Розпізнано ${newShapes.length} лін.${dropped ? ` (ще ${dropped} відкинуто як шум)` : ''} — можна редагувати як звичайні фігури`
          : 'Не вдалося розпізнати чіткі лінії — спробуйте підняти чутливість або перезняти фото при кращому освітленні',
      );
    }, 30);
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (selected && shapes[shapes.length - 1] === selected) deselect();
    shapes.pop();
    requestRedraw();
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (!shapes.length) return;
    if (confirm('Очистити все полотно?')) { setShapes([]); deselect(); requestRedraw(); }
  });

  // ---------------------------------------------------------------------
  // Selection + exact-dimension panel
  // ---------------------------------------------------------------------
  const dimPanel = document.getElementById('dimPanel2d');

  function select(s) { selected = s; renderDimPanel(); requestRedraw(); }
  function deselect() { selected = null; renderDimPanel(); requestRedraw(); }

  function renderDimPanel() {
    dimPanel.innerHTML = '';
    if (!selected) { dimPanel.classList.add('hidden'); return; }
    dimPanel.classList.remove('hidden');

    const title = document.createElement('p');
    title.className = 'dim-panel-title';
    title.textContent = KIND_LABELS[selected.type] || selected.type;
    dimPanel.appendChild(title);

    function field(labelText, getVal, setVal) {
      const row = document.createElement('div');
      row.className = 'dim-row';
      const label = document.createElement('span');
      label.className = 'dim-label';
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.className = 'dim-input';
      input.value = formatMm(getVal());
      input.addEventListener('change', () => {
        const v = parseMm(input.value);
        if (v !== null && v > 0) { setVal(v); requestRedraw(); renderDimPanel(); }
        else input.value = formatMm(getVal());
      });
      const unit = document.createElement('span');
      unit.className = 'dim-unit';
      unit.textContent = 'мм';
      row.append(label, input, unit);
      dimPanel.appendChild(row);
    }

    if (selected.type === 'line') {
      field('Довжина', () => shapeLengthMm(selected), (v) => {
        const dx = selected.x2 - selected.x1, dy = selected.y2 - selected.y1;
        const cur = Math.hypot(dx, dy) || 1;
        const k = v / cur;
        selected.x2 = selected.x1 + dx * k;
        selected.y2 = selected.y1 + dy * k;
      });
    } else if (selected.type === 'rect') {
      field('Ширина', () => Math.abs(selected.x2 - selected.x1), (v) => { selected.x2 = selected.x1 + Math.sign(selected.x2 - selected.x1 || 1) * v; });
      field('Висота', () => Math.abs(selected.y2 - selected.y1), (v) => { selected.y2 = selected.y1 + Math.sign(selected.y2 - selected.y1 || 1) * v; });
    } else if (selected.type === 'circle') {
      field('Радіус', () => selected.r, (v) => { selected.r = v; });
    } else if (selected.type === 'leader') {
      const row = document.createElement('div');
      row.className = 'dim-row';
      const label = document.createElement('span');
      label.className = 'dim-label';
      label.textContent = 'Текст';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dim-input';
      input.style.textAlign = 'left';
      input.value = selected.text || '';
      input.addEventListener('change', () => { selected.text = input.value; requestRedraw(); });
      row.append(label, input);
      dimPanel.appendChild(row);
    } else if (selected.type === 'arc') {
      field('Радіус', () => selected.r, (v) => { selected.r = v; });
      const row = document.createElement('div');
      row.className = 'dim-row';
      const label = document.createElement('span'); label.className = 'dim-label'; label.textContent = 'Кут';
      const minus = document.createElement('button'); minus.className = 'dim-step'; minus.textContent = '–';
      const val = document.createElement('span'); val.className = 'dim-input'; val.style.textAlign = 'center';
      const plus = document.createElement('button'); plus.className = 'dim-step'; plus.textContent = '+';
      const sweep = () => ((selected.endDeg - selected.startDeg + 360) % 360) || 360;
      val.textContent = `${Math.round(sweep())}°`;
      minus.addEventListener('click', () => { selected.endDeg = selected.startDeg + Math.max(15, sweep() - 15); requestRedraw(); renderDimPanel(); });
      plus.addEventListener('click', () => { selected.endDeg = selected.startDeg + Math.min(360, sweep() + 15); requestRedraw(); renderDimPanel(); });
      row.append(label, minus, val, plus);
      dimPanel.appendChild(row);
    } else if (selected.type === 'tilearea') {
      field('Ширина приміщення', () => Math.abs(selected.x2 - selected.x1), (v) => { selected.x2 = selected.x1 + Math.sign(selected.x2 - selected.x1 || 1) * v; });
      field('Висота приміщення', () => Math.abs(selected.y2 - selected.y1), (v) => { selected.y2 = selected.y1 + Math.sign(selected.y2 - selected.y1 || 1) * v; });
      field('Плитка — ширина', () => selected.tileW, (v) => { selected.tileW = v; });
      field('Плитка — висота', () => selected.tileH, (v) => { selected.tileH = v; });

      const groutRow = document.createElement('div');
      groutRow.className = 'dim-row';
      const groutLabel = document.createElement('span'); groutLabel.className = 'dim-label'; groutLabel.textContent = 'Шов';
      const groutMinus = document.createElement('button'); groutMinus.className = 'dim-step'; groutMinus.textContent = '–';
      const groutVal = document.createElement('span'); groutVal.className = 'dim-input'; groutVal.style.textAlign = 'center';
      const groutPlus = document.createElement('button'); groutPlus.className = 'dim-step'; groutPlus.textContent = '+';
      groutVal.textContent = `${formatMm(selected.grout)} мм`;
      const clampGrout = (v) => Math.max(0, Math.round(v * 10) / 10);
      groutMinus.addEventListener('click', () => { selected.grout = clampGrout(selected.grout - 0.5); requestRedraw(); renderDimPanel(); });
      groutPlus.addEventListener('click', () => { selected.grout = clampGrout(selected.grout + 0.5); requestRedraw(); renderDimPanel(); });
      groutRow.append(groutLabel, groutMinus, groutVal, groutPlus);
      dimPanel.appendChild(groutRow);

      const photoBtn = document.createElement('button');
      photoBtn.className = 'action-btn';
      photoBtn.textContent = tileImageCache.has(selected.id) ? '🖼 Змінити фото плитки' : '🖼 Завантажити фото плитки';
      photoBtn.addEventListener('click', () => {
        tilePhotoInput.dataset.targetId = String(selected.id);
        tilePhotoInput.click();
      });
      dimPanel.appendChild(photoBtn);

      const summary = document.createElement('p');
      summary.className = 'hatch-label';
      summary.textContent = tileAreaSummary(selected);
      dimPanel.appendChild(summary);
    }

    if (selected.type === 'rect' || selected.type === 'circle') {
      const hatchLabel = document.createElement('p');
      hatchLabel.className = 'hatch-label';
      hatchLabel.textContent = 'Штрихування (матеріал)';
      dimPanel.appendChild(hatchLabel);
      const wrap = document.createElement('div');
      wrap.className = 'hatch-options';
      HATCH_LIST.forEach(({ key, label: hLabel }) => {
        const b = document.createElement('button');
        b.className = 'hatch-btn' + ((selected.hatch || null) === key ? ' active' : '');
        b.textContent = hLabel;
        b.addEventListener('click', () => {
          selected.hatch = key;
          requestRedraw();
          renderDimPanel();
        });
        wrap.appendChild(b);
      });
      dimPanel.appendChild(wrap);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'dim-delete';
    delBtn.textContent = '🗑 Видалити';
    delBtn.addEventListener('click', () => {
      setShapes(shapes.filter((s) => s !== selected));
      deselect();
    });
    dimPanel.appendChild(delBtn);
  }

  // ---------------------------------------------------------------------
  // Pointer interaction: one finger draws (shape tool) or selects/pans
  // (select tool); two fingers always pinch-zoom around their midpoint.
  // ---------------------------------------------------------------------
  const activePointers = new Map();
  let primaryPointerId = null;
  let downClient = { x: 0, y: 0 }, downTime = 0;
  let drawStartMm = null;
  let panStart = null;   // { offsetX, offsetY, clientX, clientY }
  let moveShape = null;  // shape being dragged (select tool, grabbed on a shape)
  let moveShapeStart = null; // snapshot of its coordinates at drag start
  let moveGrabMm = null;
  let pinchStartDist = 0, pinchStartScale = 1, pinchMidClient = null;
  let freehandPoints = null;  // 'Олівець' — raw sampled path of the stroke in progress
  let polylineDraft = null;   // 'Полілінія' — { points: [mm,...], previewEnd: mm|null }
  let erasing = false;        // 'Ластик' — dragging deletes whatever passes under the finger

  function currentPinchDist() {
    const pts = [...activePointers.values()];
    return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  function currentPinchMid() {
    const pts = [...activePointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  // 'Ластик' — erases only the part of a line/polyline/freehand stroke that
  // actually passes under the eraser, splitting it into whatever piece(s)
  // remain — not "delete the whole shape you happened to touch". Closed/
  // filled shapes (rect, circle, arc, leader, tile area) don't have a
  // meaningful partial cut, so those still erase as a whole shape.
  const ERASE_RADIUS_PX = 14;

  // All t's (0..1) where segment a->b crosses the circle — 0, 1, or 2 of
  // them (a straight segment can pass through a circle without either
  // endpoint being inside it, entering and exiting again — that "chord"
  // case needs both roots, not just one, or the middle of a long line
  // erases as nothing at all).
  function segmentCircleTs(a, b, center, radius) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - center.x, fy = a.y - center.y;
    const A = dx * dx + dy * dy;
    if (A < 1e-9) return [];
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - radius * radius;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return [];
    const sqrtDisc = Math.sqrt(disc);
    return [(-B - sqrtDisc) / (2 * A), (-B + sqrtDisc) / (2 * A)]
      .filter((t) => t >= 0 && t <= 1)
      .sort((x, y) => x - y);
  }

  function pointsPathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return len;
  }

  const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  // Cuts the part of a point-path that passes within `radius` of `center`,
  // returning the remaining piece(s) with clean edges interpolated exactly
  // onto the eraser's circle — or null if the path doesn't reach that far
  // at all (nothing to erase, leave the shape untouched). Used for both
  // multi-point paths (freehand/polyline) and a plain 2-point line.
  function erasePointsPath(points, center, radius) {
    if (points.length < 2) return null;
    const isIn = (p) => Math.hypot(p.x - center.x, p.y - center.y) <= radius;
    let touched = isIn(points[0]);
    const pieces = [];
    let current = touched ? [] : [points[0]];

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const ts = segmentCircleTs(a, b, center, radius);
      const bIn = isIn(b);

      if (!ts.length) {
        // no crossing on this segment — either fully outside (keep b) or
        // fully inside (both endpoints already within radius, drop it)
        if (bIn) touched = true;
        else current.push(b);
        continue;
      }

      touched = true;
      let curIn = isIn(a);
      for (const t of ts) {
        const cross = lerpPt(a, b, t);
        if (!curIn) {
          // entering the eraser — close off the piece so far
          current.push(cross);
          if (current.length >= 2) pieces.push(current);
          current = [];
        } else {
          // exiting the eraser — start the next piece at the crossing
          current = [cross];
        }
        curIn = !curIn;
      }
      if (!bIn) current.push(b);
    }
    if (current.length >= 2) pieces.push(current);
    if (!touched) return null;
    return pieces.filter((pts) => pointsPathLength(pts) > 1); // drop slivers at the cut edge
  }

  // Whole-shape hit test for the types a partial cut doesn't apply to —
  // same tolerances as hitTest, but checked against one given shape rather
  // than searching for the topmost match, so the eraser can take out every
  // shape it actually touches, not just the one on top.
  function shapeHitsPoint(s, p) {
    if (s.type === 'rect') {
      const a = mmToPx({ x: s.x1, y: s.y1 }), b = mmToPx({ x: s.x2, y: s.y2 });
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const onEdge = Math.abs(p.x - x0) <= HIT_TOLERANCE_PX || Math.abs(p.x - x1) <= HIT_TOLERANCE_PX || Math.abs(p.y - y0) <= HIT_TOLERANCE_PX || Math.abs(p.y - y1) <= HIT_TOLERANCE_PX;
      const within = p.x >= x0 - HIT_TOLERANCE_PX && p.x <= x1 + HIT_TOLERANCE_PX && p.y >= y0 - HIT_TOLERANCE_PX && p.y <= y1 + HIT_TOLERANCE_PX;
      return within && onEdge;
    }
    if (s.type === 'circle' || s.type === 'arc') {
      const c = mmToPx({ x: s.cx, y: s.cy });
      const dist = Math.hypot(p.x - c.x, p.y - c.y);
      return Math.abs(dist - s.r * view.scale) <= HIT_TOLERANCE_PX + (s.lineWidthMm * view.scale) / 2;
    }
    if (s.type === 'leader') {
      const g = leaderGeometry(s);
      return Math.min(distToSegment(p, g.p1, g.p2), distToSegment(p, g.p2, g.p3)) <= HIT_TOLERANCE_PX;
    }
    if (s.type === 'tilearea') {
      const b = tileAreaBounds(s);
      return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
    }
    return false;
  }

  function eraseAt(clientX, clientY) {
    const centerMm = clientToMm(clientX, clientY);
    const centerPx = clientToPx(clientX, clientY);
    const radiusMm = ERASE_RADIUS_PX / view.scale;
    const next = [];
    let changed = false;

    for (const s of shapes) {
      if (s.type === 'freehand' || s.type === 'polyline') {
        const pieces = erasePointsPath(s.points, centerMm, radiusMm);
        if (!pieces) { next.push(s); continue; }
        changed = true;
        if (selected === s) deselect();
        for (const pts of pieces) next.push({ ...s, points: pts, id: nextId++ });
      } else if (s.type === 'line') {
        const pieces = erasePointsPath([{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }], centerMm, radiusMm);
        if (!pieces) { next.push(s); continue; }
        changed = true;
        if (selected === s) deselect();
        for (const pts of pieces) next.push({ ...s, x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, id: nextId++ });
      } else if (shapeHitsPoint(s, centerPx)) {
        changed = true;
        if (selected === s) deselect();
      } else {
        next.push(s);
      }
    }
    if (changed) { setShapes(next); requestRedraw(); }
  }

  // 'Полілінія' — commit the segment currently being dragged (previewEnd)
  // as a fixed vertex, ready for the next segment to continue from it.
  function commitPolylineSegment() {
    if (!polylineDraft || !polylineDraft.previewEnd) return;
    const last = polylineDraft.points[polylineDraft.points.length - 1];
    const end = polylineDraft.previewEnd;
    if (Math.hypot(end.x - last.x, end.y - last.y) >= 1.5) polylineDraft.points.push(end);
    polylineDraft.previewEnd = null;
    requestRedraw();
    renderChainBar();
  }
  function finishPolyline() {
    if (polylineDraft && polylineDraft.points.length >= 2) {
      shapes.push({ type: 'polyline', points: polylineDraft.points, color: state.color, lineWidthMm: state.lineWidthMm, id: nextId++ });
      select(shapes[shapes.length - 1]);
    }
    polylineDraft = null;
    requestRedraw();
    renderChainBar();
  }
  function cancelPolyline() {
    polylineDraft = null;
    requestRedraw();
    renderChainBar();
  }
  function undoPolylinePoint() {
    if (!polylineDraft) return;
    polylineDraft.points.pop();
    if (!polylineDraft.points.length) polylineDraft = null;
    requestRedraw();
    renderChainBar();
  }
  const chainBar = document.getElementById('chainBar2d');
  function renderChainBar() {
    if (chainBar) chainBar.classList.toggle('hidden', !polylineDraft);
  }
  const chainUndoBtn = document.getElementById('chainUndoBtn');
  const chainCancelBtn = document.getElementById('chainCancelBtn');
  const chainDoneBtn = document.getElementById('chainDoneBtn');
  if (chainUndoBtn) chainUndoBtn.addEventListener('click', undoPolylinePoint);
  if (chainCancelBtn) chainCancelBtn.addEventListener('click', cancelPolyline);
  if (chainDoneBtn) chainDoneBtn.addEventListener('click', finishPolyline);

  function cloneShapeCoords(s) {
    if (s.type === 'line' || s.type === 'rect' || s.type === 'leader' || s.type === 'tilearea') return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
    if (s.type === 'freehand' || s.type === 'polyline') return { points: s.points.map((p) => ({ x: p.x, y: p.y })) };
    return { cx: s.cx, cy: s.cy };
  }

  canvas.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      primaryPointerId = e.pointerId;
      downClient = { x: e.clientX, y: e.clientY };
      downTime = performance.now();
      const mm = clientToMm(e.clientX, e.clientY);

      // Any new touch clears the previous selection outline first — the
      // 'select' tool already did this for its own empty-space tap below,
      // but a freshly-drawn shape auto-selects itself (see makePreviewShape
      // commits further down), and its dashed frame used to stick around
      // through the *next* shape too if you kept drawing without switching
      // back to 'select' in between. Re-selecting a shape you actually tap
      // right after this is unaffected — select() below just runs again.
      if (selected) deselect();

      if (state.tool === 'select') {
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) {
          select(hit);
          moveShape = hit;
          moveShapeStart = cloneShapeCoords(hit);
          moveGrabMm = mm;
        } else {
          panStart = { offsetX: view.offsetX, offsetY: view.offsetY, clientX: e.clientX, clientY: e.clientY, committed: false };
        }
      } else if (state.tool === 'freehand') {
        freehandPoints = [mm];
        dragPreview = { type: 'freehand', points: freehandPoints, color: state.color, lineWidthMm: state.lineWidthMm };
        requestRedraw();
      } else if (state.tool === 'polyline') {
        if (!polylineDraft) polylineDraft = { points: [mm], previewEnd: null };
        requestRedraw();
        renderChainBar();
      } else if (state.tool === 'eraser') {
        erasing = true;
        eraseAt(e.clientX, e.clientY);
      } else {
        drawStartMm = mm;
        dragPreview = makePreviewShape(state.tool, mm.x, mm.y, mm.x, mm.y);
        requestRedraw();
      }
    } else if (activePointers.size === 2) {
      pinchStartDist = currentPinchDist();
      pinchStartScale = view.scale;
      pinchMidClient = currentPinchMid();
      // a mid-gesture second finger cancels whatever the first was doing
      panStart = null; moveShape = null; drawStartMm = null; dragPreview = null;
      freehandPoints = null; erasing = false;
      if (polylineDraft) polylineDraft.previewEnd = null;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2) {
      const dist = currentPinchDist();
      if (pinchStartDist > 10) {
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * (dist / pinchStartDist)));
        // keep the pinch midpoint stationary on the page while zooming
        const mid = currentPinchMid();
        const mmAtMid = pxToMm(clientToPx(pinchMidClient.x, pinchMidClient.y));
        view.scale = newScale;
        const midPx = clientToPx(mid.x, mid.y);
        view.offsetX = midPx.x - mmAtMid.x * view.scale;
        view.offsetY = midPx.y - mmAtMid.y * view.scale;
        requestRedraw();
      }
      return;
    }
    if (e.pointerId !== primaryPointerId) return;

    if (moveShape) {
      const mm = clientToMm(e.clientX, e.clientY);
      const dx = mm.x - moveGrabMm.x, dy = mm.y - moveGrabMm.y;
      if (moveShape.type === 'circle' || moveShape.type === 'arc') {
        moveShape.cx = moveShapeStart.cx + dx; moveShape.cy = moveShapeStart.cy + dy;
      } else if (moveShape.type === 'freehand' || moveShape.type === 'polyline') {
        moveShape.points = moveShapeStart.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      } else {
        moveShape.x1 = moveShapeStart.x1 + dx; moveShape.y1 = moveShapeStart.y1 + dy;
        moveShape.x2 = moveShapeStart.x2 + dx; moveShape.y2 = moveShapeStart.y2 + dy;
      }
      requestRedraw();
    } else if (panStart) {
      if (!panStart.committed) {
        const movedPx = Math.hypot(e.clientX - panStart.clientX, e.clientY - panStart.clientY);
        if (movedPx < PAN_START_THRESHOLD_PX) return; // dead zone — a tap's natural tremor must not "walk" the sheet
        panStart.committed = true;
        panStart.offsetX = view.offsetX; panStart.offsetY = view.offsetY;
        panStart.clientX = e.clientX; panStart.clientY = e.clientY;
      }
      view.offsetX = panStart.offsetX + (e.clientX - panStart.clientX);
      view.offsetY = panStart.offsetY + (e.clientY - panStart.clientY);
      requestRedraw();
    } else if (state.tool === 'freehand' && freehandPoints) {
      const mm = clientToMm(e.clientX, e.clientY);
      const last = freehandPoints[freehandPoints.length - 1];
      if (Math.hypot((mm.x - last.x) * view.scale, (mm.y - last.y) * view.scale) > 2) {
        freehandPoints.push(mm);
        requestRedraw();
      }
    } else if (state.tool === 'polyline' && polylineDraft) {
      polylineDraft.previewEnd = clientToMm(e.clientX, e.clientY);
      requestRedraw();
    } else if (state.tool === 'eraser' && erasing) {
      eraseAt(e.clientX, e.clientY);
    } else if (drawStartMm) {
      const mm = clientToMm(e.clientX, e.clientY);
      dragPreview = makePreviewShape(state.tool, drawStartMm.x, drawStartMm.y, mm.x, mm.y);
      dragPreview.color = state.color;
      dragPreview.lineWidthMm = state.lineWidthMm;
      requestRedraw();
    }
  });

  function endPointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) { pinchStartDist = 0; }
    if (e.pointerId !== primaryPointerId) return;

    if (moveShape) { moveShape = null; moveShapeStart = null; requestRedraw(); return; }
    if (panStart) { panStart = null; return; }
    if (erasing) { erasing = false; return; }
    if (state.tool === 'polyline' && polylineDraft) { commitPolylineSegment(); return; }

    if (state.tool === 'freehand' && freehandPoints) {
      const dt = performance.now() - downTime;
      const movedPx = Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y);
      const pts = freehandPoints;
      freehandPoints = null;
      dragPreview = null;
      if (pts.length < 2 || (movedPx < 3 && dt < 250)) { requestRedraw(); return; } // accidental tap, discard
      const shape = { type: 'freehand', points: pts, color: state.color, lineWidthMm: state.lineWidthMm, id: nextId++ };
      shapes.push(shape);
      select(shape);
      return;
    }

    if (drawStartMm) {
      const mm = clientToMm(e.clientX, e.clientY);
      const dt = performance.now() - downTime;
      const movedPx = Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y);
      const shape = makePreviewShape(state.tool, drawStartMm.x, drawStartMm.y, mm.x, mm.y);
      dragPreview = null;
      drawStartMm = null;
      const tooSmall = shape.type === 'circle' || shape.type === 'arc' ? shape.r < 1.5 : Math.hypot((shape.x2 ?? 0) - (shape.x1 ?? 0), (shape.y2 ?? 0) - (shape.y1 ?? 0)) < 1.5;
      if (movedPx < 3 && dt < 250 || tooSmall) { requestRedraw(); return; } // accidental tap, discard
      shape.color = state.color;
      shape.lineWidthMm = state.lineWidthMm;
      shape.id = nextId++;
      shapes.push(shape);
      select(shape);
      if (shape.type === 'leader') {
        const t = window.prompt('Текст виноски (наприклад: "Гвинт М8 ГОСТ 1491"):', '');
        shape.text = t || '';
        renderDimPanel();
        requestRedraw();
      }
    }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // Desktop bonus: wheel zooms around the cursor.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const mmAtCursor = clientToMm(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    const px = clientToPx(e.clientX, e.clientY);
    view.offsetX = px.x - mmAtCursor.x * view.scale;
    view.offsetY = px.y - mmAtCursor.y * view.scale;
    requestRedraw();
  }, { passive: false });

  // ---------------------------------------------------------------------
  // Export / print — always the whole page at print quality, independent
  // of the current on-screen pan/zoom.
  // ---------------------------------------------------------------------
  function renderPageToCanvas(pxPerMm) {
    const out = document.createElement('canvas');
    out.width = Math.round(pageW() * pxPerMm);
    out.height = Math.round(pageH() * pxPerMm);
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    const savedView = { ...view };
    view.scale = pxPerMm; view.offsetX = 0; view.offsetY = 0;
    for (const s of shapes) renderOneShape(octx, s, false);
    Object.assign(view, savedView);
    return out;
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    const out = renderPageToCanvas(96 / 25.4); // 96 DPI, matches the original export
    const link = document.createElement('a');
    link.download = `creslarnet-${pageKey.toLowerCase()}.png`;
    link.href = out.toDataURL('image/png');
    link.click();
  });

  document.getElementById('printBtn').addEventListener('click', () => {
    const out = renderPageToCanvas(203 / 25.4); // ~203 DPI — crisp on a typical printer
    const dataUrl = out.toDataURL('image/png');
    const img = document.createElement('img');
    img.id = 'printSheet';
    img.src = dataUrl;
    img.style.width = `${pageW()}mm`;
    img.style.height = `${pageH()}mm`;
    document.body.appendChild(img);

    // The print sheet size follows whatever format this drawing was made
    // on — an А4 drawing prints as А4, an А1 drawing as А1 — set fresh
    // each time since the user can switch format between prints.
    let pageRule = document.getElementById('dynamicPageSize');
    if (!pageRule) {
      pageRule = document.createElement('style');
      pageRule.id = 'dynamicPageSize';
      document.head.appendChild(pageRule);
    }
    pageRule.textContent = `@page { size: ${pageW()}mm ${pageH()}mm; margin: 0; }`;

    const cleanup = () => { img.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    requestAnimationFrame(() => window.print());
  });

  // ---------------------------------------------------------------------
  // Save / load — the whole project (every page, if one exists) as a
  // single .json file, the same pattern as the 3D mode's "Файл" system.
  // Shapes here are already plain data (mm coordinates, no geometry to
  // reconstruct), so unlike 3D this is a near-direct JSON.stringify.
  // ---------------------------------------------------------------------
  function buildProjectData2D() {
    const pages = project ? project.pages.map((p) => ({ number: p.number, shapes: p.shapes })) : [{ number: 1, shapes }];
    return {
      app: 'creslarnet-2d', version: 1, units: 'mm',
      pageKey,
      projectName: project ? project.name : null,
      currentPageIndex,
      pages,
    };
  }

  // A blob: URL behind an <a download> is not always honoured as a real
  // save on a phone — inside an installed PWA especially, it can silently
  // do nothing or just open the JSON in a blank tab instead of writing a
  // file. The File System Access API gives a genuine native "save to…"
  // dialog with a confirmed on-disk result, so it's tried first; the
  // download-link method remains as the fallback for browsers that don't
  // support it (Safari, Firefox, older Android WebViews).
  async function saveProject2D() {
    const filename = 'creslarnet-2d-project.json';
    const json = JSON.stringify(buildProjectData2D());

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Проєкт Creslarnet 2D', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        flashHint('Проєкт збережено');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') { flashHint('Збереження скасовано'); return; }
        // fall through to the download-link method below on any other failure
      }
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    flashHint('Проєкт збережено у файл (перевірте папку «Завантаження»)');
  }

  function loadProject2D(data) {
    if (!data || data.app !== 'creslarnet-2d' || !Array.isArray(data.pages) || !data.pages.length) {
      flashHint('Файл не розпізнано як проєкт Creslarnet 2D');
      return;
    }
    if (data.units !== 'mm') {
      flashHint('Цей файл несумісний із поточною системою мм');
      return;
    }
    deselect();
    if (polylineDraft) cancelPolyline();

    if (data.pageKey && PAGE_SIZES[data.pageKey]) {
      pageKey = data.pageKey;
      pageSizeButtons.forEach((b) => b.classList.toggle('active', b.dataset.pageSize === pageKey));
    }

    if (data.projectName) {
      project = { name: data.projectName, pages: data.pages.map((p) => ({ number: p.number, shapes: p.shapes })) };
      currentPageIndex = Math.min(Math.max(0, data.currentPageIndex || 0), project.pages.length - 1);
      setShapes(project.pages[currentPageIndex].shapes);
    } else {
      project = null;
      currentPageIndex = 0;
      setShapes(data.pages[0].shapes || []);
    }

    let maxId = 0;
    for (const p of data.pages) for (const s of p.shapes) if (s.id) maxId = Math.max(maxId, s.id);
    nextId = maxId + 1;

    fitPageToView();
    renderProjectPanel();
    flashHint('Проєкт завантажено');
  }

  document.getElementById('saveProjectBtn2d').addEventListener('click', saveProject2D);
  const projectFileInput2d = document.getElementById('projectFileInput2d');
  document.getElementById('loadProjectBtn2d').addEventListener('click', () => projectFileInput2d.click());
  projectFileInput2d.addEventListener('change', () => {
    const file = projectFileInput2d.files[0];
    projectFileInput2d.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadProject2D(JSON.parse(reader.result));
      } catch (e) {
        flashHint('Не вдалося прочитати файл проєкту');
      }
    };
    reader.readAsText(file);
  });

  // ---------------------------------------------------------------------
  // Any actual viewport change (rotate, browser chrome show/hide, a
  // desktop window resize) re-fits the sheet fresh instead of nudging the
  // existing pan/zoom — that's what stops it "wandering": every layout
  // change lands it back centred and maximised for the new screen size
  // rather than drifting from wherever it happened to be. Opening/closing
  // a drawer never fires any of this — the drawers are fixed overlays that
  // don't touch the canvas's own size.
  function handleViewportChange() { resizeCanvas(); fitPageToView(); }
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('orientationchange', handleViewportChange);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', handleViewportChange);
  resizeCanvas();
  fitPageToView();
  frame();
  flashHint('Лист зафіксований — панорамування тільки свідомим перетягуванням порожнього місця · два пальці — масштаб', 6000);

  window.__creslarnet2d = {
    get project() { return project; },
    get currentPageIndex() { return currentPageIndex; },
    get shapes() { return shapes; },
    get selected() { return selected; },
    get pageKey() { return pageKey; },
    get polylineDraft() { return polylineDraft; },
    pageW, pageH, view, clientToMm, fitPageToView,
    buildProjectData2D, loadProject2D, saveProject2D,
    hasTileImage: (id) => tileImageCache.has(id),
    computeTileGrid,
    warpPerspective, runScanPipeline, straightenPath, solveHomography, applyHomography,
    zhangSuenThin, traceSkeleton, simplifyRDP, otsuThreshold, toGrayscale, binarize,
  };
})();
