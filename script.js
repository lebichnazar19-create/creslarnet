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
  const PAGE_W_MM = 210, PAGE_H_MM = 297; // A4
  const PALETTE = ['#1a1a1a', '#e63946', '#2a9d8f', '#264653', '#f4a261', '#8338ec'];
  const MIN_SCALE = 0.4, MAX_SCALE = 60; // screen px per mm
  const HIT_TOLERANCE_PX = 10;

  const canvas = document.getElementById('drawCanvas');
  const ctx = canvas.getContext('2d');

  const view = { scale: 1, offsetX: 0, offsetY: 0 }; // offsetX/Y = screen-px position of mm-origin (0,0)

  function fitPageToView() {
    const rect = canvas.getBoundingClientRect();
    const margin = 36;
    const availW = Math.max(50, rect.width - margin * 2);
    const availH = Math.max(50, rect.height - margin * 2);
    view.scale = Math.min(availW / PAGE_W_MM, availH / PAGE_H_MM, MAX_SCALE);
    view.offsetX = (rect.width - PAGE_W_MM * view.scale) / 2;
    view.offsetY = (rect.height - PAGE_H_MM * view.scale) / 2;
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

  const KIND_LABELS = { line: 'Лінія', rect: 'Прямокутник', circle: 'Коло', arc: 'Дуга' };

  function makePreviewShape(tool, x1, y1, x2, y2) {
    if (tool === 'line') return { type: 'line', x1, y1, x2, y2 };
    if (tool === 'rect') return { type: 'rect', x1, y1, x2, y2 };
    if (tool === 'circle') return { type: 'circle', cx: x1, cy: y1, r: Math.hypot(x2 - x1, y2 - y1) };
    if (tool === 'arc') return { type: 'arc', cx: x1, cy: y1, r: Math.hypot(x2 - x1, y2 - y1), startDeg: 0, endDeg: 360 };
    return null;
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
    const pTL = mmToPx({ x: 0, y: 0 }), pBR = mmToPx({ x: PAGE_W_MM, y: PAGE_H_MM });
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(pTL.x, pTL.y, pBR.x - pTL.x, pBR.y - pTL.y);
    ctx.restore();

    // light 10mm reference grid, page-clipped
    ctx.save();
    ctx.beginPath();
    ctx.rect(pTL.x, pTL.y, pBR.x - pTL.x, pBR.y - pTL.y);
    ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= PAGE_W_MM; x += 10) {
      const a = mmToPx({ x, y: 0 }), b = mmToPx({ x, y: PAGE_H_MM });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let y = 0; y <= PAGE_H_MM; y += 10) {
      const a = mmToPx({ x: 0, y }), b = mmToPx({ x: PAGE_W_MM, y });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();

    for (const s of shapes) drawShape(ctx, s, false);
    if (dragPreview) drawShape(ctx, dragPreview, true);

    if (selected) {
      ctx.save();
      ctx.strokeStyle = '#8338ec';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      const pad = 4;
      if (selected.type === 'line') {
        const a = mmToPx({ x: selected.x1, y: selected.y1 }), b = mmToPx({ x: selected.x2, y: selected.y2 });
        ctx.strokeRect(Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad, Math.abs(b.x - a.x) + pad * 2, Math.abs(b.y - a.y) + pad * 2);
      } else if (selected.type === 'rect') {
        const a = mmToPx({ x: selected.x1, y: selected.y1 }), b = mmToPx({ x: selected.x2, y: selected.y2 });
        ctx.strokeRect(Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad, Math.abs(b.x - a.x) + pad * 2, Math.abs(b.y - a.y) + pad * 2);
      } else {
        const c = mmToPx({ x: selected.cx, y: selected.cy });
        ctx.beginPath(); ctx.arc(c.x, c.y, selected.r * view.scale + pad, 0, Math.PI * 2); ctx.stroke();
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
      toolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
      if (state.tool !== 'select') deselect();
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

  function currentPinchDist() {
    const pts = [...activePointers.values()];
    return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  function currentPinchMid() {
    const pts = [...activePointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  function cloneShapeCoords(s) {
    if (s.type === 'line' || s.type === 'rect') return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
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
          panStart = { offsetX: view.offsetX, offsetY: view.offsetY, clientX: e.clientX, clientY: e.clientY };
        }
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
      } else {
        moveShape.x1 = moveShapeStart.x1 + dx; moveShape.y1 = moveShapeStart.y1 + dy;
        moveShape.x2 = moveShapeStart.x2 + dx; moveShape.y2 = moveShapeStart.y2 + dy;
      }
      requestRedraw();
    } else if (panStart) {
      view.offsetX = panStart.offsetX + (e.clientX - panStart.clientX);
      view.offsetY = panStart.offsetY + (e.clientY - panStart.clientY);
      requestRedraw();
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
    out.width = Math.round(PAGE_W_MM * pxPerMm);
    out.height = Math.round(PAGE_H_MM * pxPerMm);
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    const savedView = { ...view };
    view.scale = pxPerMm; view.offsetX = 0; view.offsetY = 0;
    for (const s of shapes) drawShape(octx, s, false);
    Object.assign(view, savedView);
    return out;
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    const out = renderPageToCanvas(96 / 25.4); // 96 DPI, matches the original export
    const link = document.createElement('a');
    link.download = 'creslarnet-a4.png';
    link.href = out.toDataURL('image/png');
    link.click();
  });

  document.getElementById('printBtn').addEventListener('click', () => {
    const out = renderPageToCanvas(203 / 25.4); // ~203 DPI — crisp on a typical printer
    const dataUrl = out.toDataURL('image/png');
    const img = document.createElement('img');
    img.id = 'printSheet';
    img.src = dataUrl;
    document.body.appendChild(img);
    const cleanup = () => { img.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    requestAnimationFrame(() => window.print());
  });

  // ---------------------------------------------------------------------
  window.addEventListener('resize', () => { resizeCanvas(); });
  resizeCanvas();
  fitPageToView();
  frame();

  window.__creslarnet2d = { get shapes() { return shapes; }, get selected() { return selected; }, view, clientToMm, fitPageToView };
})();
