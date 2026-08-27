import * as THREE from './vendor/three/three.module.min.js';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';
import { CSG } from './csg.js';
import { createMaterial, createPaintMaterial, MATERIAL_LABELS } from './materials.js';

// ---------------------------------------------------------------------------
// Constants
//
// One THREE.js unit = one millimetre. Every distance in this file (object
// sizes, wall/window dimensions, camera placement, speeds…) is a plain mm
// value — there is no separate "world scale" to convert, so a mesh built
// with e.g. BoxGeometry(200, 200, 200) really is a 200 mm cube.
// ---------------------------------------------------------------------------
const PALETTE = ['#1a1a1a', '#e63946', '#2a9d8f', '#264653', '#f4a261', '#8338ec'];
const DEFAULT_PAINT = '#cfcfd6';
const WALL_HEIGHT = 2600;
const WALL_THICKNESS = 150;
const DEFAULT_WALL_COLOR = '#e8e4da';
const WINDOW_WIDTH = 1000;
const WINDOW_HEIGHT = 1200;
const EYE_HEIGHT = 1650;
const WALK_SPEED = 3200; // mm / second (≈ a brisk walking pace)
const PAPER_COLOR = '#f7f4ec'; // warm paper white, distinct from the neutral default object tint

const KIND_LABELS = {
  cube: 'Куб', cylinder: 'Циліндр', pipe: 'Труба', sphere: 'Сфера', cone: 'Конус',
  wall: 'Стіна', window: 'Вікно', paper: 'Папір', sketchLine: 'Лінія на папері',
  rebar: 'Арматура', beam: 'Балка', merged: 'Об’єднаний об’єкт',
};

// Quantize to the coordinate system's stated resolution: 0.1 mm.
const roundMm = (v) => Math.round(v * 10) / 10;

// Ukrainian-locale number formatting: space-grouped thousands, comma decimal.
function formatMm(value, decimals = 1) {
  const fixed = Math.abs(value) < 1e-9 ? (0).toFixed(decimals) : value.toFixed(decimals);
  const neg = fixed.startsWith('-');
  const [intPart, decPart] = (neg ? fixed.slice(1) : fixed).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const withDecimals = decPart !== undefined ? `${grouped},${decPart}` : grouped;
  return neg ? `-${withDecimals}` : withDecimals;
}

// Classic map/CAD "nice number" scale-bar step: 1-2-5 × a power of ten.
function niceMm(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const step of [1, 2, 5]) {
    if (raw <= step * mag) return step * mag;
  }
  return 10 * mag;
}

// ---------------------------------------------------------------------------
// Scene bootstrap
// ---------------------------------------------------------------------------
const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const SKY_COLOR = 0xbfe0e6;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.Fog(SKY_COLOR, 26000, 90000);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// Near/far start wide and get tightened every frame by updateAdaptiveClipping()
// to whatever's actually ahead of the camera — a fixed pair can't cover
// "2 mm from a bolt" and "80 m across a plot" at once even with a
// logarithmic depth buffer.
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 1000000);
camera.rotation.order = 'YXZ';
const INITIAL_CAMERA_POS = new THREE.Vector3(6000, 5000, 9000);
camera.position.copy(INITIAL_CAMERA_POS);

const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a63, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3e0, 1.6);
sun.position.set(10000, 14000, 6000);
sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536);
sun.shadow.camera.left = -20000;
sun.shadow.camera.right = 20000;
sun.shadow.camera.top = 20000;
sun.shadow.camera.bottom = -20000;
sun.shadow.camera.far = 50000;
sun.shadow.bias = -0.0008;
scene.add(sun);

const groundGeo = new THREE.PlaneGeometry(80000, 80000);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xd8dcc9, roughness: 0.95, metalness: 0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 80 divisions across an 80 m plot = one grid line per metre (1000 mm).
const grid = new THREE.GridHelper(80000, 80, 0x7a8a70, 0xa9b39a);
grid.material.opacity = 0.35;
grid.material.transparent = true;
grid.position.y = 1;
scene.add(grid);

// Free camera state — no orbit pivot, just where the camera is and which
// way it's looking. yaw/pitch are the single source of truth for
// orientation; camera.rotation is rebuilt from them every frame.
let yaw = 0, pitch = 0;
function faceDirection(dir) {
  // camera's horizontal forward under rotation.set(pitch, yaw, 0, 'YXZ') is
  // (-sin(yaw), 0, -cos(yaw)); solve yaw/pitch backward from a look direction.
  yaw = Math.atan2(-dir.x, -dir.z);
  pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
}
faceDirection(new THREE.Vector3(0, 1000, 0).sub(camera.position).normalize());
camera.rotation.set(pitch, yaw, 0, 'YXZ');

function resetView() {
  camera.position.copy(INITIAL_CAMERA_POS);
  faceDirection(new THREE.Vector3(0, 1000, 0).sub(INITIAL_CAMERA_POS).normalize());
  toast('Вигляд скинуто');
}

// How far away is whatever the camera is actually looking at? Used to keep
// the depth buffer, the scale bar, and the fly speed all matched to "how
// zoomed in are we right now" — a tiny object needs a slow, fine approach
// and a near plane a fraction of a millimetre; an open plot needs speed and
// clip planes tens of metres out.
function forwardHitDistance() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  raycaster.set(camera.position, dir);
  const hits = raycaster.intersectObjects(raycastTargets.concat(ground), false);
  if (hits.length) return hits[0].distance;
  return Math.max(1000, Math.abs(camera.position.y) * 3, 3000);
}

// Perspective zoom is naturally "real" — moving at a distance-scaled speed
// feels the same whether you're 5 mm or 5 m from what's ahead. What breaks
// across a huge range is the depth buffer, so the clip planes are re-fit
// to the current reference distance every frame instead of a fixed pair.
function updateAdaptiveClipping(refDist) {
  const near = Math.max(0.1, refDist / 200);
  const far = Math.max(200000, refDist * 200);
  if (Math.abs(camera.near - near) > 1e-6 || Math.abs(camera.far - far) > 1) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let nextId = 1;
const objects = [];        // { id, kind, root, wallLength? }
const raycastTargets = []; // flat list of every raycastable mesh, tagged userData.ownerId

let mode = 'edit'; // 'edit' | 'walk'
let selected = null;
let placingKind = null;
let placingLibraryEntry = null; // a saved "Мої об'єкти" entry waiting for a tap to place it
let wallDrawing = false;
let wallColor = DEFAULT_WALL_COLOR;
let wallPoints = [];
let wallSegmentsThisDraw = [];
let windowToolActive = false;
let windowFrameColor = '#f2efe6';
let holeToolActive = false;
let holeRadius = 80; // mm
let moveMode = false;
let moveDragging = false;
let paperDrawing = false;
let paperDrawDragging = false;
let sketchLineColor = PALETTE[0];
let drawStartWorld = null;

// Free-camera navigation: one finger down free (not claimed by move/paper
// drawing) looks around; WASD/arrows move on desktop. Two fingers pinch —
// resizes the selected object if one is picked, otherwise moves the camera
// forward/back (spread apart = forward, pinch together = back).
let lookPointerId = null;
let lastLookX = 0, lastLookY = 0;
let primaryPointerId = null;
const keys = new Set();
const activePointers = new Map(); // pointerId -> {x, y}, for pinch detection
let pinchStartDist = 0;
let pinchStartScale = null;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function rayFromClient(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((x - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((y - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------------------
// Scale bar — the honest way to show "zoom level" in a perspective view:
// how many millimetres a fixed on-screen length covers at whatever the
// camera is looking at, rounded to a friendly 1-2-5 step (same idea as a
// map's scale bar).
// ---------------------------------------------------------------------------
const scaleBarEl = document.getElementById('scaleBar');
const scaleBarFillEl = document.getElementById('scaleBarFill');
const scaleBarLabelEl = document.getElementById('scaleBarLabel');
const TARGET_BAR_PX = 90;

function updateScaleBar(refDist) {
  const vFov = (camera.fov * Math.PI) / 180;
  const screenPx = renderer.domElement.clientHeight || window.innerHeight;
  const mmPerPixel = (2 * refDist * Math.tan(vFov / 2)) / screenPx;
  const mm = niceMm(mmPerPixel * TARGET_BAR_PX);
  scaleBarFillEl.style.width = `${(mm / mmPerPixel).toFixed(1)}px`;
  scaleBarLabelEl.textContent = `${formatMm(mm, 0)} мм`;
}

function colorSwatchRow(currentColor, onPick) {
  const row = document.createElement('div');
  row.className = 'panel-row';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c.toLowerCase() === currentColor?.toLowerCase() ? ' selected' : '');
    b.style.background = c;
    b.addEventListener('click', () => onPick(c));
    row.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.value = currentColor || '#888888';
  custom.className = 'swatch-custom';
  custom.style.background = 'none';
  custom.addEventListener('input', () => onPick(custom.value));
  row.appendChild(custom);
  return row;
}

function materialSwatchRow(onPick) {
  const row = document.createElement('div');
  row.className = 'panel-row';
  for (const key of Object.keys(MATERIAL_LABELS)) {
    const b = document.createElement('button');
    b.className = 'pbtn';
    b.textContent = MATERIAL_LABELS[key];
    b.addEventListener('click', () => onPick(key));
    row.appendChild(b);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Object registry
// ---------------------------------------------------------------------------
function registerObject(kind, root, extra = {}) {
  const id = nextId++;
  root.traverse((o) => { if (o.isMesh) { o.userData.ownerId = id; raycastTargets.push(o); } });
  const record = { id, kind, root, ...extra };
  objects.push(record);
  scene.add(root);
  return record;
}

function removeObject(record) {
  // Unconverted ink marks belong to their sheet — throw the paper away and
  // they go with it. Already-converted rebar/pipe/beam are independent by
  // then (registered under their own kind), so they're untouched.
  if (record.kind === 'paper') {
    objects.filter((r) => r.kind === 'sketchLine' && r.paperId === record.id).forEach(removeObject);
  }
  scene.remove(record.root);
  record.root.traverse((o) => {
    if (o.isMesh) {
      const idx = raycastTargets.indexOf(o);
      if (idx !== -1) raycastTargets.splice(idx, 1);
      o.geometry.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
  const idx = objects.indexOf(record);
  if (idx !== -1) objects.splice(idx, 1);
  if (selected === record) deselect();
}

function findRecordByMesh(mesh) {
  const id = mesh.userData.ownerId;
  return objects.find((r) => r.id === id) || null;
}

// ---------------------------------------------------------------------------
// Shape builders
// ---------------------------------------------------------------------------
function buildPipeGeometry(outerR = 220, innerR = 140, length = 1400, radialSegments = 20) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: radialSegments });
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(length / 2, 0, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

const KIND_DEFS = {
  cube: { build: () => ({ geometry: new THREE.BoxGeometry(1000, 1000, 1000), restY: 500 }) },
  sphere: { build: () => ({ geometry: new THREE.SphereGeometry(500, 32, 16), restY: 500 }) },
  cone: { build: () => ({ geometry: new THREE.ConeGeometry(500, 1000, 32), restY: 500 }) },
  cylinder: { build: () => ({ geometry: new THREE.CylinderGeometry(500, 500, 1000, 32), restY: 500 }) },
  pipe: { build: () => ({ geometry: buildPipeGeometry(), restY: 220, isPipe: true }) },
  // A4-proportioned virtual sheet of paper — a drawing surface, not a solid prop.
  paper: { build: () => ({ geometry: new THREE.BoxGeometry(210, 3, 297), restY: 1.5 }) },
};

function addObject(kind, point) {
  const def = KIND_DEFS[kind];
  const built = def.build();
  const material = createPaintMaterial(kind === 'paper' ? PAPER_COLOR : DEFAULT_PAINT);
  const mesh = new THREE.Mesh(built.geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(roundMm(point.x), roundMm(point.y + built.restY), roundMm(point.z));
  const record = registerObject(kind, mesh, { isPipe: !!built.isPipe });
  select(record);
  return record;
}

function addWallSegment(p1, p2, color) {
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  const length = Math.hypot(dx, dz);
  if (length < 50) return null; // ignore an accidental near-zero-length tap
  const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS);
  const material = createPaintMaterial(color);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set((p1.x + p2.x) / 2, WALL_HEIGHT / 2, (p1.z + p2.z) / 2);
  mesh.rotation.y = Math.atan2(-dz, dx);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return registerObject('wall', mesh, { wallLength: length });
}

// ---------------------------------------------------------------------------
// Virtual paper — a flat sheet you draw ink lines on, each line later
// convertible into a real 3D object (rebar / pipe / beam). Paper is always
// placed upright like every other object, so a line drawn on it only ever
// varies in world X/Z — the same box-between-two-points shape as a wall
// segment covers it, just thin and flush with the sheet instead of tall.
// ---------------------------------------------------------------------------
const LINE_WIDTH = 4;   // mm, ink stroke width
const LINE_HEIGHT = 1;  // mm, stroke thickness (sits just above the paper)
const MIN_LINE_LENGTH = 3; // mm — ignore an accidental micro-tap

function lineBoxGeometry(aWorld, bWorld) {
  const dx = bWorld.x - aWorld.x, dz = bWorld.z - aWorld.z;
  const length = Math.hypot(dx, dz);
  return { length, rotationY: Math.atan2(-dz, dx) };
}

let previewLineMesh = null;
function updatePreviewLine(aWorld, bWorld) {
  clearPreviewLine();
  const { length, rotationY } = lineBoxGeometry(aWorld, bWorld);
  if (length < 1) return;
  const geometry = new THREE.BoxGeometry(length, LINE_HEIGHT, LINE_WIDTH);
  const material = new THREE.MeshBasicMaterial({ color: sketchLineColor, transparent: true, opacity: 0.75 });
  previewLineMesh = new THREE.Mesh(geometry, material);
  previewLineMesh.position.set((aWorld.x + bWorld.x) / 2, (aWorld.y + bWorld.y) / 2 + LINE_HEIGHT, (aWorld.z + bWorld.z) / 2);
  previewLineMesh.rotation.y = rotationY;
  scene.add(previewLineMesh);
}
function clearPreviewLine() {
  if (!previewLineMesh) return;
  scene.remove(previewLineMesh);
  previewLineMesh.geometry.dispose();
  previewLineMesh.material.dispose();
  previewLineMesh = null;
}

function addSketchLine(paperRecord, aWorld, bWorld, color) {
  const { length, rotationY } = lineBoxGeometry(aWorld, bWorld);
  if (length < MIN_LINE_LENGTH) return null;
  const geometry = new THREE.BoxGeometry(length, LINE_HEIGHT, LINE_WIDTH);
  const material = createPaintMaterial(color);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set((aWorld.x + bWorld.x) / 2, (aWorld.y + bWorld.y) / 2 + LINE_HEIGHT, (aWorld.z + bWorld.z) / 2);
  mesh.rotation.y = rotationY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return registerObject('sketchLine', mesh, {
    paperId: paperRecord.id,
    lineLength: length,
    lineStart: aWorld.clone(),
    lineEnd: bWorld.clone(),
  });
}

// Converting a line into a solid: build geometry along local +X (matching
// the pipe convention), then aim +X at the line's actual direction and drop
// it at the midpoint — independent of the line's length or the paper's tilt.
const CONVERT_DEFS = {
  rebar: {
    buildGeometry: (length) => { const g = new THREE.CylinderGeometry(6, 6, length, 12); g.rotateZ(Math.PI / 2); return g; },
    buildMaterial: () => createMaterial('metal', undefined, scene.environment),
    extra: {},
  },
  pipe: {
    buildGeometry: (length) => buildPipeGeometry(70, 55, length, 16),
    buildMaterial: () => createMaterial('metal', undefined, scene.environment),
    extra: { isPipe: true },
  },
  beam: {
    buildGeometry: (length) => new THREE.BoxGeometry(length, 100, 50),
    buildMaterial: () => createMaterial('wood', undefined, scene.environment),
    extra: {},
  },
};

function convertSketchLine(record, targetKind) {
  const def = CONVERT_DEFS[targetKind];
  const a = record.lineStart, b = record.lineEnd;
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length();
  if (length < 1) { toast('Лінія замала для перетворення'); return; }
  dir.normalize();

  const geometry = def.buildGeometry(length);
  const material = def.buildMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  removeObject(record);
  const newRecord = registerObject(targetKind, mesh, def.extra);
  select(newRecord);
  toast(`Перетворено на: ${KIND_LABELS[targetKind]}`);
}

function enterPaperDrawMode() {
  if (!selected || selected.kind !== 'paper') return;
  paperDrawing = true;
  hideEl(selectionPanelEl);
  renderPaperDrawPill();
  showEl(modePillEl);
  toast('Тягніть по паперу, щоб намалювати лінію');
}

function exitPaperDrawMode() {
  paperDrawing = false;
  paperDrawDragging = false;
  drawStartWorld = null;
  clearPreviewLine();
  hideEl(modePillEl);
  if (selected) renderSelectionPanel();
}

function renderPaperDrawPill() {
  modePillEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'Малюйте лінії на папері';
  modePillEl.appendChild(label);
  modePillEl.appendChild(colorSwatchRow(sketchLineColor, (c) => { sketchLineColor = c; }));
  const done = document.createElement('button');
  done.textContent = '✓ Готово';
  done.addEventListener('click', exitPaperDrawMode);
  modePillEl.appendChild(done);
}

function buildWindowGroup(width, height, thickness, frameColor) {
  const group = new THREE.Group();
  const bar = 60;
  const frameMat = createPaintMaterial(frameColor);
  const glassMat = createMaterial('glass', '#bfe3f0', scene.environment);

  function addBar(w, h, x, y) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, thickness), frameMat);
    m.position.set(x, y, 0);
    m.userData.role = 'frame';
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  addBar(width, bar, 0, height / 2 - bar / 2);
  addBar(width, bar, 0, -height / 2 + bar / 2);
  addBar(bar, height - 2 * bar, -width / 2 + bar / 2, 0);
  addBar(bar, height - 2 * bar, width / 2 - bar / 2, 0);

  const glassGeom = new THREE.BoxGeometry(width - 2 * bar, height - 2 * bar, Math.max(20, thickness * 0.5));
  const glassMesh = new THREE.Mesh(glassGeom, glassMat);
  glassMesh.userData.role = 'glass';
  group.add(glassMesh);

  group.userData.windowParams = { width, height, thickness, frameColor };
  return group;
}

// ---------------------------------------------------------------------------
// Selection & outline
// ---------------------------------------------------------------------------
let outlineHelper = null;
function select(record) {
  if (selected === record) return;
  deselect();
  selected = record;
  outlineHelper = new THREE.BoxHelper(record.root, 0x8338ec);
  scene.add(outlineHelper);
  closePopover();
  renderSelectionPanel();
}

function deselect() {
  if (outlineHelper) { scene.remove(outlineHelper); outlineHelper = null; }
  selected = null;
  holeToolActive = false;
  moveMode = false;
  moveDragging = false;
  paperDrawing = false;
  paperDrawDragging = false;
  drawStartWorld = null;
  clearPreviewLine();
  hideEl(selectionPanelEl);
  hideEl(modePillEl);
}

// Intrinsic size (local-space bounding box × scale) — the object's own
// width/height/depth regardless of how it's rotated in the world, matching
// what "this cube is 200 mm" should mean.
function getObjectSizeMm(record) {
  if (record.kind === 'window') {
    const p = record.root.userData.windowParams;
    return new THREE.Vector3(p.width, p.height, p.thickness).multiply(record.root.scale);
  }
  const mesh = record.root;
  mesh.geometry.computeBoundingBox(); // cheap; re-run in case CSG just replaced the geometry
  const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
  size.multiply(mesh.scale);
  return size;
}

// The UNSCALED local size along one axis — needed to work out what scale
// factor turns "current geometry" into "the mm the user just typed in".
function getBaseAxisSizeMm(record, axis) {
  if (record.kind === 'window') {
    const p = record.root.userData.windowParams;
    return { x: p.width, y: p.height, z: p.thickness }[axis];
  }
  record.root.geometry.computeBoundingBox();
  return record.root.geometry.boundingBox.getSize(new THREE.Vector3())[axis] || 1;
}

// Live-updated while a two-finger pinch is scaling the selected object, so
// the panel's own size inputs stay in sync without a full DOM rebuild.
let sizeInputRefs = null;
function refreshSizeInputs() {
  if (!sizeInputRefs || sizeInputRefs.record !== selected) return;
  const size = getObjectSizeMm(selected);
  sizeInputRefs.x.value = formatMm(size.x);
  sizeInputRefs.y.value = formatMm(size.y);
  sizeInputRefs.z.value = formatMm(size.z);
}

function applyAxisSizeMm(record, axis, mm) {
  mm = Math.max(0.5, roundMm(mm));
  const base = getBaseAxisSizeMm(record, axis);
  record.root.scale[axis] = mm / base;
  outlineHelper?.update();
  refreshSizeInputs();
}

function buildSizeSection(record) {
  const section = document.createElement('div');
  section.className = 'size-section';
  const refs = {};
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div');
    row.className = 'size-row';

    const label = document.createElement('span');
    label.className = 'axis-label';
    label.textContent = axis.toUpperCase();

    const minus = document.createElement('button');
    minus.type = 'button'; minus.className = 'stepper-btn'; minus.textContent = '–';

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'size-input';

    const plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'stepper-btn'; plus.textContent = '+';

    const unit = document.createElement('span');
    unit.className = 'unit-label';
    unit.textContent = 'мм';

    const current = () => getObjectSizeMm(record)[axis];
    const step = () => Math.max(0.5, current() * 0.1); // 10% nudge — sane at both mm and metre scale
    input.value = formatMm(current());

    minus.addEventListener('click', () => applyAxisSizeMm(record, axis, current() - step()));
    plus.addEventListener('click', () => applyAxisSizeMm(record, axis, current() + step()));
    input.addEventListener('change', () => {
      const v = parseFloat(input.value.replace(',', '.'));
      if (Number.isFinite(v) && v > 0) applyAxisSizeMm(record, axis, v);
      else input.value = formatMm(current());
    });

    row.append(label, minus, input, plus, unit);
    section.appendChild(row);
    refs[axis] = input;
  }
  sizeInputRefs = { record, ...refs };
  return section;
}

function formatDeg(v) {
  const rounded = Math.round(v * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toString().replace('.', ',');
}

// Fine rotation control — a stepper + exact-value field at 1° resolution
// (turntable-style, around the object's own vertical axis), replacing the
// old fixed 15° nudge buttons.
let rotationInputRef = null;
function buildRotationSection(record) {
  const row = document.createElement('div');
  row.className = 'size-row';

  const label = document.createElement('span');
  label.className = 'axis-label';
  label.textContent = '⟲';

  const minus = document.createElement('button');
  minus.type = 'button'; minus.className = 'stepper-btn'; minus.textContent = '–';

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'size-input';

  const plus = document.createElement('button');
  plus.type = 'button'; plus.className = 'stepper-btn'; plus.textContent = '+';

  const unit = document.createElement('span');
  unit.className = 'unit-label';
  unit.textContent = '°';

  const current = () => {
    const deg = THREE.MathUtils.radToDeg(record.root.rotation.y) % 360;
    return deg < 0 ? deg + 360 : deg;
  };
  const apply = (deg) => {
    deg = ((deg % 360) + 360) % 360;
    record.root.rotation.y = THREE.MathUtils.degToRad(deg);
    outlineHelper?.update();
    input.value = formatDeg(deg);
  };
  input.value = formatDeg(current());

  minus.addEventListener('click', () => apply(current() - 1));
  plus.addEventListener('click', () => apply(current() + 1));
  input.addEventListener('change', () => {
    const v = parseFloat(input.value.replace(',', '.'));
    if (Number.isFinite(v)) apply(v);
    else input.value = formatDeg(current());
  });

  row.append(label, minus, input, plus, unit);
  rotationInputRef = { record, input };
  return row;
}

function currentPaintColor(record) {
  const meshes = [];
  record.root.traverse((o) => { if (o.isMesh && o.userData.role !== 'glass') meshes.push(o); });
  const m = meshes[0]?.material;
  return m?.userData?.creslarnetColor || DEFAULT_PAINT;
}

function applyColorToSelected(color) {
  if (!selected) return;
  selected.root.traverse((o) => {
    if (!o.isMesh || o.userData.role === 'glass') return;
    const type = o.material.userData.creslarnetType;
    const newMat = type && type !== 'paint' ? createMaterial(type, color, scene.environment) : createPaintMaterial(color);
    o.material.dispose();
    o.material = newMat;
  });
  renderSelectionPanel();
}

function applyMaterialToSelected(type) {
  if (!selected) return;
  const color = currentPaintColor(selected);
  selected.root.traverse((o) => {
    if (!o.isMesh || o.userData.role === 'glass') return;
    const newMat = createMaterial(type, color, scene.environment);
    o.material.dispose();
    o.material = newMat;
  });
  renderSelectionPanel();
}

// ---------------------------------------------------------------------------
// Hole tool (works on any single-mesh object: cube/cylinder/pipe/sphere/cone/wall)
// ---------------------------------------------------------------------------
function performHolePlacement(clientX, clientY) {
  if (!selected || !selected.root.isMesh) return;
  const ray = rayFromClient(clientX, clientY);
  const hits = ray.intersectObject(selected.root, false);
  if (!hits.length) { toast('Торкніться поверхні обраного об’єкта'); return; }
  const hit = hits[0];
  const worldNormal = hit.face.normal.clone().transformDirection(selected.root.matrixWorld).normalize();
  selected.root.geometry.computeBoundingSphere();
  const reach = (selected.root.geometry.boundingSphere?.radius || 500) * 2.5 + 200;

  const drillGeom = new THREE.CylinderGeometry(holeRadius, holeRadius, reach, 20);
  const drill = new THREE.Mesh(drillGeom);
  drill.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
  drill.position.copy(hit.point);
  drill.updateMatrixWorld(true);

  try {
    const result = CSG.subtract(selected.root, drill);
    if (!result.attributes.position.count) throw new Error('empty result');
    selected.root.geometry.dispose();
    selected.root.geometry = result;
    toast('Отвір створено');
  } catch (e) {
    toast('Не вдалося вирізати отвір тут — спробуйте інше місце');
  }
  holeToolActive = false;
  hideEl(modePillEl);
  showEl(selectionPanelEl);
  if (outlineHelper) outlineHelper.update();
}

// ---------------------------------------------------------------------------
// Pipe attach / snap
// ---------------------------------------------------------------------------
function attachSelectedPipe() {
  if (!selected || !selected.isPipe) return;
  const others = objects.filter((r) => r !== selected);
  if (!others.length) { toast('Немає інших об’єктів для прикріплення'); return; }

  const pipe = selected.root;
  pipe.updateMatrixWorld(true);
  // Read the actual length from the geometry — pipes converted from a drawn
  // line can be any length, not just the freestanding-primitive default.
  pipe.geometry.computeBoundingBox();
  const localHalf = pipe.geometry.boundingBox.getSize(new THREE.Vector3()).x / 2;
  const endA = new THREE.Vector3(localHalf, 0, 0).applyMatrix4(pipe.matrixWorld);
  const endB = new THREE.Vector3(-localHalf, 0, 0).applyMatrix4(pipe.matrixWorld);

  let best = null;
  for (const rec of others) {
    const targetCenter = new THREE.Vector3();
    new THREE.Box3().setFromObject(rec.root).getCenter(targetCenter);
    const targetRadius = new THREE.Box3().setFromObject(rec.root).getSize(new THREE.Vector3()).length() / 2.5;
    for (const [end, other] of [[endA, endB], [endB, endA]]) {
      const d = end.distanceTo(targetCenter);
      if (!best || d < best.d) best = { d, near: end, far: other, targetCenter, targetRadius };
    }
  }
  if (!best) return;

  const dirToTarget = new THREE.Vector3().subVectors(best.targetCenter, best.far).normalize();
  const attachPoint = new THREE.Vector3().copy(best.targetCenter).sub(dirToTarget.clone().multiplyScalar(best.targetRadius));
  const newDir = new THREE.Vector3().subVectors(attachPoint, best.far).normalize();
  const length = localHalf * 2;

  // does local +X currently point toward `near` or away from it?
  const currentAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(pipe.quaternion);
  const nearIsPlusX = currentAxis.dot(new THREE.Vector3().subVectors(best.near, best.far)) > 0;
  const axisTarget = nearIsPlusX ? newDir : newDir.clone().negate();

  pipe.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), axisTarget);
  const center = new THREE.Vector3().copy(best.far).add(newDir.clone().multiplyScalar(length / 2));
  pipe.position.copy(center);
  if (outlineHelper) outlineHelper.update();
  toast('Трубу прикріплено');
}

// ---------------------------------------------------------------------------
// Selection panel rendering
// ---------------------------------------------------------------------------
const selectionPanelEl = document.getElementById('selectionPanel');
const modePillEl = document.getElementById('modePill');
function hideEl(el) { el.classList.add('hidden'); }
function showEl(el) { el.classList.remove('hidden'); }

function renderSelectionPanel() {
  if (!selected) { hideEl(selectionPanelEl); return; }
  selectionPanelEl.innerHTML = '';
  showEl(selectionPanelEl);
  hideEl(modePillEl);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-x';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', deselect);
  selectionPanelEl.appendChild(closeBtn);

  const title = document.createElement('p');
  title.className = 'panel-title';
  title.textContent = KIND_LABELS[selected.kind] || selected.kind;
  selectionPanelEl.appendChild(title);

  if (selected.kind === 'sketchLine') {
    const info = document.createElement('p');
    info.className = 'dim-readout';
    info.textContent = `Довжина: ${formatMm(selected.lineLength)} мм`;
    selectionPanelEl.appendChild(info);

    const hint = document.createElement('p');
    hint.className = 'dim-readout';
    hint.textContent = 'Перетворити на реальний об’єкт:';
    selectionPanelEl.appendChild(hint);

    const convertRow = document.createElement('div');
    convertRow.className = 'panel-row';
    for (const kind of ['rebar', 'pipe', 'beam']) {
      const b = document.createElement('button');
      b.className = 'pbtn';
      b.textContent = `→ ${KIND_LABELS[kind]}`;
      b.addEventListener('click', () => convertSketchLine(selected, kind));
      convertRow.appendChild(b);
    }
    selectionPanelEl.appendChild(convertRow);

    const delBtn = document.createElement('button');
    delBtn.className = 'pbtn danger wide';
    delBtn.textContent = '🗑 Видалити лінію';
    delBtn.addEventListener('click', () => removeObject(selected));
    selectionPanelEl.appendChild(delBtn);
    return;
  }

  selectionPanelEl.appendChild(buildSizeSection(selected));
  selectionPanelEl.appendChild(buildRotationSection(selected));

  selectionPanelEl.appendChild(colorSwatchRow(currentPaintColor(selected), applyColorToSelected));
  selectionPanelEl.appendChild(materialSwatchRow(applyMaterialToSelected));

  const actions = document.createElement('div');
  actions.className = 'panel-row';

  const moveBtn = document.createElement('button');
  moveBtn.className = 'pbtn'; moveBtn.textContent = '✥ Перемістити';
  moveBtn.addEventListener('click', enterMoveMode);
  actions.appendChild(moveBtn);

  if (selected.kind === 'paper') {
    const drawBtn = document.createElement('button');
    drawBtn.className = 'pbtn'; drawBtn.textContent = '✎ Малювати лінії';
    drawBtn.addEventListener('click', enterPaperDrawMode);
    actions.appendChild(drawBtn);
  }

  if (selected.root.isMesh) {
    const holeBtn = document.createElement('button');
    holeBtn.className = 'pbtn'; holeBtn.textContent = '◎ Отвір';
    holeBtn.addEventListener('click', enterHoleMode);
    actions.appendChild(holeBtn);
  }

  if (selected.isPipe) {
    const attachBtn = document.createElement('button');
    attachBtn.className = 'pbtn'; attachBtn.textContent = '⚭ Прикріпити';
    attachBtn.addEventListener('click', attachSelectedPipe);
    actions.appendChild(attachBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'pbtn danger'; delBtn.textContent = '🗑 Видалити';
  delBtn.addEventListener('click', () => removeObject(selected));
  actions.appendChild(delBtn);

  selectionPanelEl.appendChild(actions);
}

function enterMoveMode() {
  moveMode = true;
  hideEl(selectionPanelEl);
  modePillEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'Перетягніть об’єкт по підлозі';
  const done = document.createElement('button');
  done.textContent = '✓ Готово';
  done.addEventListener('click', () => {
    moveMode = false;
    hideEl(modePillEl);
    renderSelectionPanel();
  });
  modePillEl.appendChild(label);
  modePillEl.appendChild(done);
  showEl(modePillEl);
}

function enterHoleMode() {
  holeToolActive = true;
  hideEl(selectionPanelEl);
  renderHolePill();
  showEl(modePillEl);
}

function renderHolePill() {
  modePillEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'Торкніться поверхні';
  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const minus = document.createElement('button'); minus.textContent = '–';
  const val = document.createElement('span'); val.textContent = formatMm(holeRadius * 2, 0) + ' мм';
  const plus = document.createElement('button'); plus.textContent = '+';
  minus.addEventListener('click', () => { holeRadius = Math.max(30, holeRadius - 20); renderHolePill(); });
  plus.addEventListener('click', () => { holeRadius = Math.min(400, holeRadius + 20); renderHolePill(); });
  stepper.append(minus, val, plus);
  const cancel = document.createElement('button');
  cancel.className = 'ghost'; cancel.textContent = 'Скасувати';
  cancel.addEventListener('click', () => { holeToolActive = false; hideEl(modePillEl); renderSelectionPanel(); });
  modePillEl.append(label, stepper, cancel);
}

// ---------------------------------------------------------------------------
// Bottom toolbar + popovers
// ---------------------------------------------------------------------------
const popoverEl = document.getElementById('popover');
const toolbarEl = document.getElementById('toolbar');

function closePopover() {
  popoverEl.classList.add('hidden');
  toolbarEl.querySelectorAll('.tb-btn.active').forEach((b) => b.classList.remove('active'));
}

function openPopover(panel, btn) {
  const wasOpenForSameBtn = !popoverEl.classList.contains('hidden') && btn.classList.contains('active');
  closePopover();
  if (wasOpenForSameBtn) return;
  btn.classList.add('active');
  popoverEl.innerHTML = '';
  buildPopoverContent(panel);
  popoverEl.classList.remove('hidden');
}

function buildPopoverContent(panel) {
  if (panel === 'objects') {
    const h = document.createElement('h3'); h.textContent = 'Додати об’єкт'; popoverEl.appendChild(h);
    const row = document.createElement('div'); row.className = 'panel-row';
    for (const kind of ['cube', 'cylinder', 'pipe', 'sphere', 'cone', 'paper']) {
      const b = document.createElement('button');
      b.className = 'pbtn' + (placingKind === kind ? ' on' : '');
      b.textContent = KIND_LABELS[kind];
      b.addEventListener('click', () => {
        placingKind = placingKind === kind ? null : kind;
        deselect();
        closePopover();
        if (placingKind) toast(`Торкніться підлоги або об’єкта, щоб розмістити: ${KIND_LABELS[kind]}`);
      });
      row.appendChild(b);
    }
    popoverEl.appendChild(row);
  }

  if (panel === 'walls') {
    const h = document.createElement('h3'); h.textContent = 'Стіни будинку'; popoverEl.appendChild(h);
    const row = document.createElement('div'); row.className = 'panel-row';
    const drawBtn = document.createElement('button');
    drawBtn.className = 'pbtn wide' + (wallDrawing ? ' on' : '');
    drawBtn.textContent = wallDrawing ? '■ Завершити стіну' : '✎ Малювати стіну';
    drawBtn.addEventListener('click', () => {
      if (wallDrawing) { finishWallDrawing(); } else { startWallDrawing(); }
      closePopover();
    });
    row.appendChild(drawBtn);
    popoverEl.appendChild(row);
    popoverEl.appendChild(colorSwatchRow(wallColor, (c) => { wallColor = c; }));
  }

  if (panel === 'windows') {
    const h = document.createElement('h3'); h.textContent = 'Вставити вікно'; popoverEl.appendChild(h);
    const row = document.createElement('div'); row.className = 'panel-row';
    const btn = document.createElement('button');
    btn.className = 'pbtn wide' + (windowToolActive ? ' on' : '');
    btn.textContent = windowToolActive ? 'Вимкнути інструмент' : 'Торкніться стіни, щоб вставити';
    btn.addEventListener('click', () => {
      windowToolActive = !windowToolActive;
      deselect();
      closePopover();
      if (windowToolActive) toast('Торкніться стіни в потрібному місці');
    });
    row.appendChild(btn);
    popoverEl.appendChild(row);
    popoverEl.appendChild(colorSwatchRow(windowFrameColor, (c) => { windowFrameColor = c; }));
  }

  if (panel === 'file') {
    const h = document.createElement('h3'); h.textContent = 'Проєкт'; popoverEl.appendChild(h);
    const row = document.createElement('div'); row.className = 'panel-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'pbtn wide'; saveBtn.textContent = '⭳ Зберегти у файл';
    saveBtn.addEventListener('click', () => { saveProject(); closePopover(); });
    const loadBtn = document.createElement('button');
    loadBtn.className = 'pbtn wide'; loadBtn.textContent = '⭱ Завантажити з файлу';
    loadBtn.addEventListener('click', () => { document.getElementById('fileInput').click(); closePopover(); });
    row.append(saveBtn, loadBtn);
    popoverEl.appendChild(row);

    const h2 = document.createElement('h3'); h2.textContent = 'Групи об’єктів'; popoverEl.appendChild(h2);
    const groupRow = document.createElement('div'); groupRow.className = 'panel-row';
    const groupBtn = document.createElement('button');
    groupBtn.className = 'pbtn wide';
    groupBtn.textContent = '▦ Виділити й згрупувати';
    groupBtn.addEventListener('click', () => { enterGroupSelectMode(); closePopover(); });
    groupRow.appendChild(groupBtn);
    popoverEl.appendChild(groupRow);

    buildMyObjectsSection();
  }
}

function buildMyObjectsSection() {
  const h3 = document.createElement('h3'); h3.textContent = 'Мої об’єкти'; popoverEl.appendChild(h3);
  const library = loadLibrary();
  if (!library.length) {
    const empty = document.createElement('p');
    empty.className = 'dim-readout';
    empty.textContent = 'Поки порожньо — виділіть об’єкти вище й натисніть «Зберегти як об’єкт».';
    popoverEl.appendChild(empty);
    return;
  }
  for (const entry of [...library].reverse()) {
    const row = document.createElement('div');
    row.className = 'panel-row library-row';
    const insertBtn = document.createElement('button');
    insertBtn.className = 'pbtn';
    insertBtn.textContent = `${entry.name} · ${entry.count} шт.`;
    insertBtn.addEventListener('click', () => {
      placingLibraryEntry = entry;
      closePopover();
      toast(`Торкніться, де розмістити: ${entry.name}`);
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'pbtn danger';
    delBtn.textContent = '🗑';
    delBtn.title = 'Видалити з «Моїх об’єктів»';
    delBtn.addEventListener('click', () => {
      saveLibrary(loadLibrary().filter((e) => e.id !== entry.id));
      popoverEl.innerHTML = '';
      buildPopoverContent('file');
    });
    row.append(insertBtn, delBtn);
    popoverEl.appendChild(row);
  }
}

toolbarEl.querySelectorAll('.tb-btn[data-panel]').forEach((btn) => {
  btn.addEventListener('click', () => openPopover(btn.dataset.panel, btn));
});

// ---------------------------------------------------------------------------
// Wall drawing
// ---------------------------------------------------------------------------
function startWallDrawing() {
  wallDrawing = true;
  wallPoints = [];
  wallSegmentsThisDraw = [];
  deselect();
  toast('Торкайтесь підлоги, щоб додавати кути стіни');
}

function finishWallDrawing() {
  wallDrawing = false;
  wallPoints = [];
  wallSegmentsThisDraw = [];
  toast('Стіну завершено');
}

function addWallPoint(clientX, clientY) {
  const ray = rayFromClient(clientX, clientY);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(groundPlane, hit)) return;
  hit.set(roundMm(hit.x), roundMm(hit.y), roundMm(hit.z));
  wallPoints.push(hit.clone());
  if (wallPoints.length >= 2) {
    const rec = addWallSegment(wallPoints[wallPoints.length - 2], wallPoints[wallPoints.length - 1], wallColor);
    if (rec) wallSegmentsThisDraw.push(rec);
  }
}

// ---------------------------------------------------------------------------
// Window insertion
// ---------------------------------------------------------------------------
function insertWindowAt(clientX, clientY) {
  const wallMeshes = objects.filter((r) => r.kind === 'wall').map((r) => r.root);
  if (!wallMeshes.length) { toast('Спершу побудуйте стіну'); return; }
  const ray = rayFromClient(clientX, clientY);
  const hits = ray.intersectObjects(wallMeshes, false);
  if (!hits.length) { toast('Торкніться стіни'); return; }
  const hit = hits[0];
  const wallRecord = findRecordByMesh(hit.object);
  const wall = hit.object;
  const local = wall.worldToLocal(hit.point.clone());

  const margin = 120;
  const halfLen = (wallRecord.wallLength || 2) / 2;
  const maxX = Math.max(0, halfLen - WINDOW_WIDTH / 2 - margin);
  const clampedX = Math.max(-maxX, Math.min(maxX, local.x));
  const maxY = WALL_HEIGHT / 2 - WINDOW_HEIGHT / 2 - margin;
  const minY = -WALL_HEIGHT / 2 + WINDOW_HEIGHT / 2 + margin;
  const clampedY = Math.max(minY, Math.min(maxY, local.y));

  const cutterGeom = new THREE.BoxGeometry(WINDOW_WIDTH, WINDOW_HEIGHT, WALL_THICKNESS * 3);
  const cutter = new THREE.Mesh(cutterGeom);
  cutter.position.copy(wall.localToWorld(new THREE.Vector3(clampedX, clampedY, 0)));
  cutter.quaternion.copy(wall.quaternion);
  cutter.updateMatrixWorld(true);

  try {
    const result = CSG.subtract(wall, cutter);
    if (!result.attributes.position.count) throw new Error('empty');
    wall.geometry.dispose();
    wall.geometry = result;
  } catch (e) {
    toast('Не вдалося вставити вікно тут');
    return;
  }

  const winGroup = buildWindowGroup(WINDOW_WIDTH, WINDOW_HEIGHT, WALL_THICKNESS, windowFrameColor);
  winGroup.position.copy(wall.localToWorld(new THREE.Vector3(clampedX, clampedY, 0)));
  winGroup.quaternion.copy(wall.quaternion);
  winGroup.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  registerObject('window', winGroup);
  windowToolActive = false;
  toast('Вікно вставлено');
}

// ---------------------------------------------------------------------------
// Pointer interaction — priority order per touch count:
//   2 fingers + an object selected  → pinch-scale that object
//   1 finger, moveMode active       → drag the object across the floor
//   1 finger, paperDrawing active   → ink a line on the active sheet
//   1 finger, otherwise             → look around (free camera)
//   (on release) short tap, no drag → select / place / draw a wall point / cut
// ---------------------------------------------------------------------------
let downX = 0, downY = 0, downTime = 0;

// Desktop bonus: the mouse wheel flies the camera forward/back along the
// view direction, scaled by what's ahead so a tick feels equally
// fine-grained up close or brisk out in the open (same idea as the
// touch pinch-to-move gesture below).
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'edit' || moveMode || paperDrawing) return;
  e.preventDefault();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const refDist = forwardHitDistance();
  camera.position.addScaledVector(dir, -e.deltaY * refDist * 0.002);
}, { passive: false });

function currentPinchDist() {
  const pts = [...activePointers.values()];
  return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

canvas.addEventListener('pointerdown', (e) => {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1) {
    primaryPointerId = e.pointerId;
    downX = e.clientX; downY = e.clientY; downTime = performance.now();

    if (mode === 'edit' && moveMode && selected) {
      moveDragging = true;
    } else if (mode === 'edit' && paperDrawing && selected) {
      scene.updateMatrixWorld(true);
      const hits = rayFromClient(e.clientX, e.clientY).intersectObject(selected.root, false);
      if (hits.length) {
        drawStartWorld = hits[0].point.clone();
        paperDrawDragging = true;
      }
    } else if (!moveMode && !paperDrawing) {
      lookPointerId = e.pointerId;
      lastLookX = e.clientX; lastLookY = e.clientY;
    }
  } else if (activePointers.size === 2 && !moveMode && !paperDrawing) {
    pinchStartDist = currentPinchDist();
    // with something selected, pinch resizes it; otherwise it drives the camera
    pinchStartScale = selected ? selected.root.scale.clone() : null;
    lookPointerId = null; // second finger arrived — hand off from look to pinch
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2 && !moveMode && !paperDrawing) {
    const dist = currentPinchDist();
    if (selected && pinchStartScale) {
      if (pinchStartDist > 10) {
        const ratio = Math.max(0.05, dist / pinchStartDist);
        selected.root.scale.copy(pinchStartScale).multiplyScalar(ratio);
        outlineHelper?.update();
        refreshSizeInputs();
      }
    } else if (!selected && pinchStartDist > 0) {
      // navigation pinch: spreading fingers apart moves forward, pinching
      // together moves back — tracked incrementally so continuing the
      // gesture keeps moving rather than saturating at one ratio
      const delta = dist - pinchStartDist;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const refDist = forwardHitDistance();
      camera.position.addScaledVector(dir, delta * refDist * 0.004);
      if (mode === 'walk') camera.position.y = EYE_HEIGHT;
      pinchStartDist = dist;
    }
    return;
  }
  if (mode === 'edit' && moveMode && moveDragging && selected && e.pointerId === primaryPointerId) {
    const ray = rayFromClient(e.clientX, e.clientY);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -selected.root.position.y);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, hit)) {
      selected.root.position.x = roundMm(hit.x);
      selected.root.position.z = roundMm(hit.z);
      outlineHelper?.update();
    }
    return;
  }
  if (mode === 'edit' && paperDrawing && paperDrawDragging && selected && drawStartWorld && e.pointerId === primaryPointerId) {
    const hits = rayFromClient(e.clientX, e.clientY).intersectObject(selected.root, false);
    if (hits.length) updatePreviewLine(drawStartWorld, hits[0].point);
    return;
  }
  if (lookPointerId !== null && e.pointerId === lookPointerId) {
    handleFreeLook(e);
  }
});

function endPointer(e) {
  const wasPinching = activePointers.size >= 2 && pinchStartDist > 0;
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) { pinchStartScale = null; pinchStartDist = 0; }
  if (lookPointerId === e.pointerId) lookPointerId = null;

  if (e.type === 'pointercancel') {
    if (mode === 'edit' && moveMode) moveDragging = false;
    if (mode === 'edit' && paperDrawing) { paperDrawDragging = false; drawStartWorld = null; clearPreviewLine(); }
    return;
  }

  if (mode === 'edit' && moveMode) { moveDragging = false; return; }
  if (mode === 'edit' && paperDrawing) {
    if (paperDrawDragging && drawStartWorld && selected && e.pointerId === primaryPointerId) {
      const hits = rayFromClient(e.clientX, e.clientY).intersectObject(selected.root, false);
      clearPreviewLine();
      if (hits.length) {
        const line = addSketchLine(selected, drawStartWorld, hits[0].point, sketchLineColor);
        if (!line) toast('Занадто коротка лінія');
      } else {
        toast('Лінія має лишатися на папері');
      }
      paperDrawDragging = false;
      drawStartWorld = null;
    }
    return;
  }
  if (wasPinching) return; // a pinch finger lifting is never a tap
  if (mode === 'walk') return; // walk mode has no tap-to-place/select
  if (e.pointerId !== primaryPointerId) return;

  const dx = e.clientX - downX, dy = e.clientY - downY;
  const dt = performance.now() - downTime;
  if (dx * dx + dy * dy > 49 || dt > 600) return; // a look-drag, not a tap
  if (e.target !== canvas) return;

  handleEditTap(e.clientX, e.clientY);
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);

function handleEditTap(x, y) {
  // A mesh's matrixWorld only refreshes on render; force it here so a tap
  // arriving in the same tick as an object add/move never raycasts stale.
  scene.updateMatrixWorld(true);

  if (placingKind) {
    const ray = rayFromClient(x, y);
    const hits = ray.intersectObjects(raycastTargets.concat(ground), false);
    if (hits.length) {
      addObject(placingKind, hits[0].point);
    } else {
      toast('Не вдалося визначити точку розміщення');
    }
    placingKind = null;
    return;
  }
  if (placingLibraryEntry) {
    const ray = rayFromClient(x, y);
    const hits = ray.intersectObjects(raycastTargets.concat(ground), false);
    if (hits.length) {
      insertMiniObject(placingLibraryEntry.data, hits[0].point);
      toast(`Розміщено: ${placingLibraryEntry.name}`);
    } else {
      toast('Не вдалося визначити точку розміщення');
    }
    placingLibraryEntry = null;
    return;
  }
  if (groupSelectMode) { toggleGroupMember(x, y); return; }
  if (wallDrawing) { addWallPoint(x, y); return; }
  if (windowToolActive) { insertWindowAt(x, y); return; }
  if (holeToolActive) { performHolePlacement(x, y); return; }

  const ray = rayFromClient(x, y);
  const hits = ray.intersectObjects(raycastTargets, false);
  if (hits.length) {
    const rec = findRecordByMesh(hits[0].object);
    if (rec) select(rec);
  } else {
    deselect();
  }
}

// ---------------------------------------------------------------------------
// Free camera navigation — shared by edit mode (fly anywhere, build) and
// walk mode (human eye-height tour, hidden UI). One finger not claimed by
// move/paper-draw looks around; WASD/arrows move on desktop; on touch, a
// two-finger pinch moves forward/back (spread = forward, pinch = back) —
// the same gesture resizes the selected object instead when one is picked.
// ---------------------------------------------------------------------------
const walkExitBtn = document.getElementById('walkExit');
const crosshairEl = document.getElementById('crosshair');
const walkToggleBtn = document.getElementById('walkToggle');
const resetViewBtn = document.getElementById('resetViewBtn');

window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));
resetViewBtn.addEventListener('click', resetView);

function enterWalkMode() {
  mode = 'walk';
  deselect();
  closePopover();
  hideEl(document.getElementById('toolbar'));
  hideEl(scaleBarEl);
  hideEl(resetViewBtn);
  showEl(crosshairEl);
  showEl(walkExitBtn);
  camera.position.y = EYE_HEIGHT;
  // Walking tours human-scale space, not mm-level inspection — a fixed,
  // generous pair is simpler and plenty for that.
  camera.near = 10;
  camera.far = 500000;
  camera.updateProjectionMatrix();
}

function exitWalkMode() {
  mode = 'edit';
  hideEl(crosshairEl);
  hideEl(walkExitBtn);
  showEl(document.getElementById('toolbar'));
  showEl(scaleBarEl);
  showEl(resetViewBtn);
  // edit mode re-fits near/far itself every frame; no repositioning needed —
  // there's no orbit pivot to recentre, the camera just stays put and flies on.
}

walkToggleBtn.addEventListener('click', () => { mode === 'walk' ? exitWalkMode() : enterWalkMode(); });
walkExitBtn.addEventListener('click', exitWalkMode);

function handleFreeLook(e) {
  const dx = e.clientX - lastLookX, dy = e.clientY - lastLookY;
  lastLookX = e.clientX; lastLookY = e.clientY;
  const sens = 0.0035;
  yaw -= dx * sens;
  pitch -= dy * sens;
  pitch = Math.max(-1.3, Math.min(1.3, pitch));
}

// refDist is only meaningful (and only computed) in edit mode — walk mode
// ignores it and always moves at human walking speed.
function updateFreeCamera(dt, refDist) {
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  // On touch there is no strafe input any more (pinch only drives forward/
  // back) — turn to face where you want to go, same as most simple 3D
  // walkthroughs. Desktop keeps full WASD/arrow freedom.
  let mx = 0, my = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  mx = Math.max(-1, Math.min(1, mx));
  my = Math.max(-1, Math.min(1, my));
  if (mx === 0 && my === 0) return;

  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  let forward, speed;
  if (mode === 'walk') {
    // flattened to horizontal — you walk on the ground, you don't climb by looking up
    forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    speed = WALK_SPEED;
  } else {
    // true fly: forward follows the full look direction, pitch included
    forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    speed = Math.max(150, Math.min(20000, refDist * 1.5));
  }

  const move = new THREE.Vector3().addScaledVector(forward, -my).addScaledVector(right, mx);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  if (mode === 'walk') camera.position.y = EYE_HEIGHT;
}

// ---------------------------------------------------------------------------
// Save / load project
// ---------------------------------------------------------------------------
// Serialize one object record to plain JSON. `positionOverride` lets a
// caller store a position relative to some anchor (used by the object
// library) instead of the record's own absolute world position.
function serializeObjectRecord(rec, positionOverride) {
  if (rec.kind === 'window') {
    const p = rec.root.userData.windowParams;
    return {
      id: rec.id, kind: 'window',
      position: (positionOverride || rec.root.position).toArray(),
      quaternion: rec.root.quaternion.toArray(),
      scale: rec.root.scale.toArray(),
      width: p.width, height: p.height, thickness: p.thickness, frameColor: p.frameColor,
    };
  }
  const mesh = rec.root;
  return {
    id: rec.id, kind: rec.kind, isPipe: !!rec.isPipe, wallLength: rec.wallLength,
    paperId: rec.paperId, lineLength: rec.lineLength,
    lineStart: rec.lineStart?.toArray(), lineEnd: rec.lineEnd?.toArray(),
    geometry: mesh.geometry.toJSON(),
    material: { type: mesh.material.userData.creslarnetType, color: mesh.material.userData.creslarnetColor },
    position: (positionOverride || mesh.position).toArray(),
    quaternion: mesh.quaternion.toArray(),
    scale: mesh.scale.toArray(),
  };
}

function buildProjectData() {
  return { app: 'creslarnet-3d', version: 2, units: 'mm', objects: objects.map((rec) => serializeObjectRecord(rec)) };
}

// A blob: URL behind an <a download> is not always honoured as a real save
// on a phone — inside an installed PWA especially, it can silently do
// nothing or just open the JSON in a blank tab instead of writing a file.
// The File System Access API gives a genuine native "save to…" dialog with
// a confirmed on-disk result, so it's tried first; the download-link method
// remains as the fallback for browsers that don't support it (Safari,
// Firefox, older Android WebViews).
async function saveProject() {
  const filename = 'creslarnet-3d-project.json';
  const json = JSON.stringify(buildProjectData());

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Проєкт Creslarnet 3D', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      toast('Проєкт збережено');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('Збереження скасовано'); return; }
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
  toast('Проєкт збережено у файл (перевірте папку "Завантаження")');
}

function clearScene() {
  deselect();
  [...objects].forEach(removeObject);
}

// Primitive geometries (Box/Cylinder/Cone/Extrude…) serialize as a compact
// parametric shorthand rather than raw attributes, so plain
// BufferGeometryLoader can't read them back — ObjectLoader's geometry
// parser understands both that shorthand and CSG's raw-attribute output.
const geomLoader = new THREE.ObjectLoader();
function parseGeometryJSON(json) {
  return Object.values(geomLoader.parseGeometries([json], {}))[0];
}
function loadProject(data) {
  if (!data || data.app !== 'creslarnet-3d' || !Array.isArray(data.objects)) {
    toast('Файл не розпізнано як проєкт Creslarnet');
    return;
  }
  if (data.units !== 'mm') {
    toast('Цей файл збережено старішою версією (в метрах) і несумісний із поточною системою мм. Створіть проєкт заново.');
    return;
  }
  clearScene();
  let maxId = 0;
  for (const item of data.objects) {
    maxId = Math.max(maxId, item.id || 0);
    const { root, extra } = buildObjectFromItem(item);
    root.position.fromArray(item.position);
    registerObject(item.kind, root, extra);
  }
  nextId = maxId + 1;
  toast('Проєкт завантажено');
}

// Reconstructs a mesh/group from a serialized item, WITHOUT setting its
// position — callers place it themselves (project load uses the item's own
// absolute position; library insertion offsets it by wherever the user
// tapped instead).
function buildObjectFromItem(item) {
  if (item.kind === 'window') {
    const group = buildWindowGroup(item.width, item.height, item.thickness, item.frameColor);
    group.quaternion.fromArray(item.quaternion);
    if (item.scale) group.scale.fromArray(item.scale);
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { root: group, extra: {} };
  }
  const geometry = parseGeometryJSON(item.geometry);
  const material = item.material.type === 'paint'
    ? createPaintMaterial(item.material.color)
    : createMaterial(item.material.type, item.material.color, scene.environment);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.quaternion.fromArray(item.quaternion);
  if (item.scale) mesh.scale.fromArray(item.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return {
    root: mesh,
    extra: {
      isPipe: !!item.isPipe, wallLength: item.wallLength,
      paperId: item.paperId, lineLength: item.lineLength,
      lineStart: item.lineStart && new THREE.Vector3().fromArray(item.lineStart),
      lineEnd: item.lineEnd && new THREE.Vector3().fromArray(item.lineEnd),
    },
  };
}

// ---------------------------------------------------------------------------
// Object library ("Мої об'єкти") — select one or more placed objects, name
// them, and stash them in this phone's browser storage as a reusable
// mini-object (a window, a door, a whole assembly…). Anything saved here is
// available from ANY project opened in this browser afterward, unlike a
// project save file which only round-trips that one project.
// ---------------------------------------------------------------------------
const LIBRARY_KEY = 'creslarnet-object-library';
const GROUP_OUTLINE_COLOR = 0xe63946;

function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveLibrary(entries) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
    return true;
  } catch (e) {
    toast('Не вдалося зберегти — забракло місця. Видаліть щось із «Моїх об’єктів»');
    return false;
  }
}

// The anchor a group is stored relative to: centred horizontally, resting
// on its own lowest point — so re-inserting it at a tapped surface places
// the whole group flush on that surface, the same way a single object does.
function computeGroupAnchor(records) {
  const box = new THREE.Box3();
  for (const rec of records) box.union(new THREE.Box3().setFromObject(rec.root));
  const center = box.getCenter(new THREE.Vector3());
  return new THREE.Vector3(center.x, box.min.y, center.z);
}

function saveGroupAsMiniObject(name, records) {
  const anchor = computeGroupAnchor(records);
  const items = records.map((rec) => serializeObjectRecord(rec, rec.root.position.clone().sub(anchor)));
  const entry = {
    id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    count: items.length,
    createdAt: Date.now(),
    data: { app: 'creslarnet-3d-object', version: 1, units: 'mm', items },
  };
  const library = loadLibrary();
  library.push(entry);
  if (saveLibrary(library)) toast(`Збережено «${name}» до «Моїх об’єктів»`);
}

function insertMiniObject(data, worldAnchor) {
  if (!data || data.app !== 'creslarnet-3d-object' || !Array.isArray(data.items)) {
    toast('Файл не розпізнано як об’єкт Creslarnet');
    return;
  }
  const inserted = [];
  for (const item of data.items) {
    const { root, extra } = buildObjectFromItem(item);
    root.position.fromArray(item.position).add(worldAnchor);
    inserted.push(registerObject(item.kind, root, extra));
  }
  if (inserted.length === 1) select(inserted[0]);
}

// ---------- Group-select mode: tap objects to build a set, then save them ----------
let groupSelectMode = false;
const groupSelection = new Set();
const groupOutlineHelpers = new Map();

function enterGroupSelectMode() {
  deselect();
  groupSelectMode = true;
  groupSelection.clear();
  closePopover();
  renderGroupSelectPill();
  showEl(modePillEl);
  toast('Торкніться об’єктів, щоб додати їх до групи');
}

function exitGroupSelectMode() {
  groupSelectMode = false;
  for (const helper of groupOutlineHelpers.values()) scene.remove(helper);
  groupOutlineHelpers.clear();
  groupSelection.clear();
  hideEl(modePillEl);
}

function toggleGroupMember(x, y) {
  const hits = rayFromClient(x, y).intersectObjects(raycastTargets, false);
  if (!hits.length) return;
  const rec = findRecordByMesh(hits[0].object);
  if (!rec) return;
  if (groupSelection.has(rec)) {
    groupSelection.delete(rec);
    const helper = groupOutlineHelpers.get(rec);
    if (helper) { scene.remove(helper); groupOutlineHelpers.delete(rec); }
  } else {
    groupSelection.add(rec);
    const helper = new THREE.BoxHelper(rec.root, GROUP_OUTLINE_COLOR);
    scene.add(helper);
    groupOutlineHelpers.set(rec, helper);
  }
  renderGroupSelectPill();
}

function renderGroupSelectPill() {
  modePillEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `Обрано: ${groupSelection.size}`;
  modePillEl.appendChild(label);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Зберегти як об’єкт';
  saveBtn.addEventListener('click', () => {
    if (!groupSelection.size) { toast('Спершу торкніться хоча б одного об’єкта'); return; }
    const records = [...groupSelection];
    const suggested = records.length === 1 ? (KIND_LABELS[records[0].kind] || records[0].kind) : `Група (${records.length})`;
    const name = window.prompt('Назва об’єкта для «Моїх об’єктів»:', suggested);
    if (!name) return;
    saveGroupAsMiniObject(name.trim() || suggested, records);
    exitGroupSelectMode();
  });
  modePillEl.appendChild(saveBtn);

  const mergeBtn = document.createElement('button');
  mergeBtn.textContent = '🔗 Об’єднати в один';
  mergeBtn.addEventListener('click', () => {
    if (groupSelection.size < 2) { toast('Оберіть щонайменше 2 об’єкти для об’єднання'); return; }
    mergeGroupSelection([...groupSelection]);
    exitGroupSelectMode();
  });
  modePillEl.appendChild(mergeBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Скасувати';
  cancelBtn.addEventListener('click', exitGroupSelectMode);
  modePillEl.appendChild(cancelBtn);
}

// Real geometric union (not just a bundle): walks the CSG boolean union
// across every selected solid and replaces them all with one merged mesh.
// Only plain meshes qualify — windows are a Group of parts, not one
// geometry, so they're skipped with a note rather than silently dropped.
function mergeGroupSelection(records) {
  const meshRecords = records.filter((r) => r.root.isMesh);
  const skipped = records.length - meshRecords.length;
  if (meshRecords.length < 2) {
    toast('Об’єднання працює лише для простих об’єктів (не вікон) — оберіть щонайменше 2');
    return;
  }

  const base = meshRecords[0].root;
  const accumulator = new THREE.Mesh(base.geometry, base.material);
  accumulator.position.copy(base.position);
  accumulator.quaternion.copy(base.quaternion);
  accumulator.scale.copy(base.scale);
  accumulator.updateMatrixWorld(true);

  try {
    for (let i = 1; i < meshRecords.length; i++) {
      const unioned = CSG.union(accumulator, meshRecords[i].root);
      if (!unioned.attributes.position.count) throw new Error('empty union result');
      accumulator.geometry = unioned;
    }
  } catch (e) {
    toast('Не вдалося об’єднати ці об’єкти');
    return;
  }

  const merged = new THREE.Mesh(accumulator.geometry, base.material.clone());
  merged.position.copy(base.position);
  merged.quaternion.copy(base.quaternion);
  merged.scale.copy(base.scale);
  merged.castShadow = true;
  merged.receiveShadow = true;

  meshRecords.forEach(removeObject);
  const record = registerObject('merged', merged, {});
  select(record);
  toast(skipped
    ? `Об’єднано ${meshRecords.length} об’єктів (вікна пропущено). Колір/матеріал — від першого.`
    : `Об’єднано ${meshRecords.length} об’єктів в один. Колір/матеріал — від першого.`);
}

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadProject(JSON.parse(reader.result));
    } catch (err) {
      toast('Не вдалося прочитати файл проєкту');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let lastFrame = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (mode === 'edit') {
    const refDist = forwardHitDistance();
    updateAdaptiveClipping(refDist);
    updateScaleBar(refDist);
    updateFreeCamera(dt, refDist);
  } else if (mode === 'walk') {
    updateFreeCamera(dt, 0);
  }
  renderer.render(scene, camera);
}
animate();

toast('Оберіть інструмент внизу, щоб додати перший об’єкт', 3200);

// Lightweight introspection hook for debugging in the browser console —
// harmless in production, handy on a real device or in automated checks.
window.__creslarnet3d = {
  get objects() { return objects; },
  get selected() { return selected; },
  scene, camera, renderer,
  // fly the camera to look at a world point from a fixed relative offset —
  // handy for debugging/testing since there's no orbit pivot to aim any more
  lookAt(pos, distance = 3000) {
    const target = new THREE.Vector3(pos.x, pos.y, pos.z);
    const offset = new THREE.Vector3(0.35, 0.35, 1).normalize().multiplyScalar(distance);
    camera.position.copy(target).add(offset);
    faceDirection(new THREE.Vector3().subVectors(target, camera.position).normalize());
  },
};
