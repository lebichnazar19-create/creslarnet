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

  function fitPageToView() {
    const rect = canvas.getBoundingClientRect();
    const margin = 36;
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

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (selected && shapes[shapes.length - 1] === selected) deselect();
    shapes.pop();
    requestRedraw();
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (!shapes.length) return;
    if (confirm('Очистити все полотно?')) { shapes = []; deselect(); requestRedraw(); }
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
      shapes = shapes.filter((s) => s !== selected);
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

  // 'Ластик' — wipe whatever is directly under the finger, no selection step.
  function eraseAt(clientX, clientY) {
    const hit = hitTest(clientX, clientY);
    if (!hit) return;
    if (selected === hit) deselect();
    shapes = shapes.filter((s) => s !== hit);
    requestRedraw();
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

      if (state.tool === 'select') {
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) {
          select(hit);
          moveShape = hit;
          moveShapeStart = cloneShapeCoords(hit);
          moveGrabMm = mm;
        } else {
          deselect();
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
  window.addEventListener('resize', () => { resizeCanvas(); });
  resizeCanvas();
  fitPageToView();
  frame();

  window.__creslarnet2d = {
    get shapes() { return shapes; },
    get selected() { return selected; },
    get pageKey() { return pageKey; },
    get polylineDraft() { return polylineDraft; },
    pageW, pageH, view, clientToMm, fitPageToView,
    hasTileImage: (id) => tileImageCache.has(id),
    computeTileGrid,
  };
})();
