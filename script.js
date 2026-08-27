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
  const canvas = document.getElementById('drawCanvas');
  const ctx = canvas.getContext('2d');

  const state = {
    tool: 'line',
    color: '#1a1a1a',
    lineWidth: 3,
    shapes: [],      // history of finished shapes
    drawing: false,
    startX: 0,
    startY: 0,
  };

  // ---- toolbar: instruments ----
  const toolButtons = document.querySelectorAll('.tool-btn');
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      toolButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
    });
  });

  // ---- toolbar: colors ----
  const colorSwatches = document.querySelectorAll('.color-swatch');
  const customColor = document.getElementById('customColor');

  colorSwatches.forEach(sw => {
    sw.addEventListener('click', () => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      state.color = sw.dataset.color;
      customColor.value = sw.dataset.color;
    });
  });

  customColor.addEventListener('input', () => {
    colorSwatches.forEach(s => s.classList.remove('active'));
    state.color = customColor.value;
  });

  // ---- toolbar: line width ----
  const lineWidthInput = document.getElementById('lineWidth');
  const lineWidthValue = document.getElementById('lineWidthValue');
  lineWidthInput.addEventListener('input', () => {
    state.lineWidth = Number(lineWidthInput.value);
    lineWidthValue.textContent = `${state.lineWidth} px`;
  });

  // ---- toolbar: actions ----
  document.getElementById('undoBtn').addEventListener('click', () => {
    state.shapes.pop();
    redraw();
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (state.shapes.length === 0) return;
    if (confirm('Очистити все полотно?')) {
      state.shapes = [];
      redraw();
    }
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = 'creslarnet-a4.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  // ---- drawing helpers ----
  function getPos(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
    };
  }

  function drawShape(shape) {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.lineWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();

    if (shape.type === 'line') {
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
    } else if (shape.type === 'rect') {
      const w = shape.x2 - shape.x1;
      const h = shape.y2 - shape.y1;
      ctx.strokeRect(shape.x1, shape.y1, w, h);
    } else if (shape.type === 'circle') {
      const dx = shape.x2 - shape.x1;
      const dy = shape.y2 - shape.y1;
      const r = Math.sqrt(dx * dx + dy * dy);
      ctx.arc(shape.x1, shape.y1, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    state.shapes.forEach(drawShape);
  }

  // ---- pointer events ----
  canvas.addEventListener('pointerdown', (evt) => {
    const pos = getPos(evt);
    state.drawing = true;
    state.startX = pos.x;
    state.startY = pos.y;
    canvas.setPointerCapture(evt.pointerId);
  });

  canvas.addEventListener('pointermove', (evt) => {
    if (!state.drawing) return;
    const pos = getPos(evt);
    redraw();
    drawShape({
      type: state.tool,
      x1: state.startX,
      y1: state.startY,
      x2: pos.x,
      y2: pos.y,
      color: state.color,
      lineWidth: state.lineWidth,
    });
  });

  function finishDrawing(evt) {
    if (!state.drawing) return;
    state.drawing = false;
    const pos = getPos(evt);

    // ignore accidental clicks with no movement
    if (Math.abs(pos.x - state.startX) < 1 && Math.abs(pos.y - state.startY) < 1) {
      redraw();
      return;
    }

    state.shapes.push({
      type: state.tool,
      x1: state.startX,
      y1: state.startY,
      x2: pos.x,
      y2: pos.y,
      color: state.color,
      lineWidth: state.lineWidth,
    });
    redraw();
  }

  canvas.addEventListener('pointerup', finishDrawing);
  canvas.addEventListener('pointerleave', (evt) => {
    if (state.drawing) finishDrawing(evt);
  });

  redraw();
})();
