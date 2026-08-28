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

// One axis-colour convention for the whole app: X red, Y blue (vertical —
// 3ds Max convention), Z green. Used by the move/rotate gizmos and the
// dimension-line overlay so a colour always means the same axis everywhere.
const AXIS_COLOR = { x: 0xd83e3e, y: 0x3a6cd8, z: 0x3aa85a };
const AXIS_COLOR_CSS = { x: '#d83e3e', y: '#3a6cd8', z: '#3aa85a' };
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
  rebar: 'Арматура', beam: 'Балка', merged: 'Об’єднаний об’єкт', ground: 'Земля',
  compound: 'Складений об’єкт', roomFloor: 'Підлога кімнати', roomCeiling: 'Стеля кімнати',
  tile: 'Плитка', tileGrout: 'Шов (фуга)', spatialLine: 'Просторова лінія', wire: 'Провід',
};

// Standard-ish electrical wire colours — brown/blue/green-yellow (EU phase/
// neutral/earth) plus the usual extras.
const WIRE_COLORS = [
  { color: '#6b4226', name: 'коричневий' },
  { color: '#2a5db0', name: 'синій' },
  { color: '#2f8f4e', name: 'зелений' },
  { color: '#c9a227', name: 'жовтий' },
  { color: '#1a1a1a', name: 'чорний' },
  { color: '#c1272d', name: 'червоний' },
  { color: '#e8e4da', name: 'білий' },
  { color: '#8a8378', name: 'сірий' },
];

// Default footprint for a freshly-created room — a common small-bedroom size.
const DEFAULT_ROOM_PARAMS = { width: 4000, length: 3000, height: 2600 };

// How far apart an exploded object's own bounding box (in mm) — a small
// window opens by a few cm, a metre-wide assembly by proportionally more.
const EXPLODE_SPREAD_FACTOR = 0.8;

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
// Shadow mapping is OFF, full stop — every wall/object still has its own
// flat colour material (never had a texture), but a shadow map is a
// depth-comparison render that's notoriously sensitive to exactly the kind
// of GPU/driver quirks a phone can have, and it's what the "walls covered
// in solid noise" reports traced back to twice in a row (first the room's
// point light, then — since turning its shadow off didn't fix it and the
// only other shadow-caster left is the sun below — that too). Rather than
// keep chasing bias/normalBias values against hardware this can't be
// tested on directly, this is the one change that removes the whole
// mechanism: no shadow map anywhere means nothing left that can render as
// noise. Every mesh below still sets castShadow/receiveShadow — harmless
// with this off, and it means shadows can just be turned back on here in
// one place if a future fix is found.
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// AutoCAD-style dark model space: black backdrop, white grid — objects and
// their own materials/colours are untouched by this, only the environment.
const scene = new THREE.Scene();
const SKY_COLOR = 0x0d0d0f;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.Fog(SKY_COLOR, 26000, 90000);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// Near/far start wide and get tightened every frame by updateAdaptiveClipping()
// to whatever's actually ahead of the camera — a fixed pair can't cover
// "2 mm from a bolt" and "80 m across a plot" at once even with a
// logarithmic depth buffer.
const DEFAULT_FOV = 60, MIN_FOV = 32, MAX_FOV = 100;
const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, window.innerWidth / window.innerHeight, 1, 1000000);
camera.rotation.order = 'YXZ';
const INITIAL_CAMERA_POS = new THREE.Vector3(6000, 5000, 9000);
camera.position.copy(INITIAL_CAMERA_POS);

// Optical zoom — widens/narrows the field of view rather than moving the
// camera, so "zoom out" works even with no physical room to back into
// (standing inside a small room, a couple of steps from every wall).
function setFov(fov) {
  camera.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov));
  camera.updateProjectionMatrix();
}

const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a63, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3e0, 1.6);
sun.position.set(10000, 14000, 6000);
sun.castShadow = false; // see renderer.shadowMap.enabled = false above
sun.shadow.mapSize.set(1536, 1536);
sun.shadow.camera.left = -20000;
sun.shadow.camera.right = 20000;
sun.shadow.camera.top = 20000;
sun.shadow.camera.bottom = -20000;
sun.shadow.camera.far = 50000;
sun.shadow.bias = -0.0008;
scene.add(sun);

// ---------------------------------------------------------------------------
// "Ландшафт" — an optional toggle away from the default AutoCAD dark model
// space toward an outdoor look: a sky dome (a huge inverted sphere with a
// vertical gradient, so it always reads as "infinitely far away" regardless
// of where the camera is) replacing the flat dark backdrop, plus a lighter
// daylight-coloured fog. The ground itself doesn't need anything new here —
// it's already a real, selectable surface objects and rooms sit on, and
// already has a "Трава" (grass) material option via the normal colour/
// material picker on the ground's own selection panel.
// ---------------------------------------------------------------------------
let landscapeMode = false;
let skyDomeMesh = null;

function buildSkyDome() {
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#3e7fc9');   // zenith
  grad.addColorStop(0.55, '#a9cdea'); // sky
  grad.addColorStop(0.82, '#dce8ec'); // horizon haze
  grad.addColorStop(1, '#e8dfc9');   // ground-level warm tint
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.SphereGeometry(60000, 24, 16);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;
  return mesh;
}

function setLandscapeMode(on) {
  landscapeMode = on;
  if (on) {
    if (!skyDomeMesh) skyDomeMesh = buildSkyDome();
    scene.add(skyDomeMesh);
    scene.background = null; // the dome shows through instead of a flat colour
    scene.fog = new THREE.Fog(0xcfe3ef, 40000, 140000);
    hemi.intensity = 1.1;
    toast('Ландшафтний режим — небо і земля для зовнішніх сцен');
  } else {
    if (skyDomeMesh) scene.remove(skyDomeMesh);
    scene.background = new THREE.Color(SKY_COLOR);
    scene.fog = new THREE.Fog(SKY_COLOR, 26000, 90000);
    hemi.intensity = 0.9;
    toast('AutoCAD-тема');
  }
}

const groundGeo = new THREE.PlaneGeometry(80000, 80000);
// Built via the same material factory as everything else so the ground can
// go through the normal colour/material picker (grass included) once it's
// made selectable further down, once `objects`/raycastTargets exist. The
// default is 'gridGround' — the AutoCAD-style reference grid painted right
// into this one surface (see materials.js) rather than a separate helper
// hovering just above it, so nothing placed on the ground can ever show
// grid lines floating over its own surface — normal opaque occlusion
// against this single plane handles that for free.
const ground = new THREE.Mesh(groundGeo, createMaterial('gridGround', '#161618', scene.environment));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

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
  setFov(DEFAULT_FOV);
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
  const hits = raycaster.intersectObjects(raycastTargets, false);
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

// The ground is selectable (for its colour/material — grass, etc.) but is
// not a normal placed object: it's a singleton outside `objects[]`, so it
// never shows up in group-select/merge/save-load and can't be deleted.
const GROUND_ID = -1;
const groundRecord = { id: GROUND_ID, kind: 'ground', root: ground };
ground.userData.ownerId = GROUND_ID;
raycastTargets.push(ground);

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
let activeRoomId = null; // most recently created/selected room — what the "Кімната" popover edits
let tileToolActive = false;
const tileConfig = { w: 600, h: 1200, color: '#e8e4da', groutColor: '#8a8378', grout: 2 };
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
  if (id === GROUND_ID) return groundRecord;
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
// "Кімната" — a full room (floor + 4 walls + ceiling) generated from a single
// {width, length, height} spec and rebuilt from scratch whenever that spec
// changes, rather than resized by scaling. Every part is a normal top-level
// object (kind 'wall' for the walls — the same kind hand-drawn walls use, so
// window insertion and every other wall tool already works on them for
// free), just tagged with a shared roomId/roomParams/roomCenter so they can
// be found, edited together, and rebuilt in place.
// ---------------------------------------------------------------------------
let roomCounter = 0;
const roomLights = new Map(); // roomId -> THREE.PointLight, see addRoomLight()

function findRoomParts(roomId) {
  return objects.filter((r) => r.roomId === roomId);
}

// Is the camera currently standing inside a room's own footprint/height —
// not "did the user press Всередині", an actual geometric check, so it
// stays correct as they walk around, and works the same regardless of how
// they got in there. A little horizontal/vertical slack so standing right
// up against a wall still counts as inside. Returns the room's own
// {roomId, roomParams, roomCenter} (first match) or null — used both as a
// yes/no check (isCameraInsideAnyRoom) and, with the actual params/centre,
// by the minimap.
function findRoomContainingCamera() {
  const seen = new Set();
  const margin = 50; // mm
  for (const rec of objects) {
    if (!rec.roomId || seen.has(rec.roomId)) continue;
    seen.add(rec.roomId);
    const p = rec.roomParams, c = rec.roomCenter;
    const hw = p.width / 2 + margin, hl = p.length / 2 + margin;
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    if (px > c.x - hw && px < c.x + hw && pz > c.z - hl && pz < c.z + hl &&
        py > c.y - margin && py < c.y + p.height + margin) return rec;
  }
  return null;
}
function isCameraInsideAnyRoom() { return !!findRoomContainingCamera(); }

// The outdoor sun can't reach an enclosed room — its own ceiling blocks it
// — and the ambient hemisphere/environment light alone shades every
// vertical wall almost identically regardless of which way it faces (their
// surface normals are all near-horizontal, so a sky/ground ambient blend
// barely varies between them). Without its own light source a room read as
// one flat pale surface with no sense of individual walls. Each room gets
// a ceiling-mounted point light so walls get real distance/angle falloff
// and cast soft shadows, same as a real light fixture would.
// Disabled entirely — two attempts at a per-room point light (with, then
// without, its own shadow) both came back as the scene rendering as solid
// pixelated noise on the actual device. Turning the shadow off wasn't
// enough, so the light itself is the suspect, not just its shadow map;
// rather than keep guessing at *why* on hardware this can't be tested
// directly against, rooms go back to exactly the lighting they had before
// any of this — the scene's plain hemisphere + directional sun, nothing
// room-specific. Walls are (and always were) flat MeshStandardMaterial
// paint, no texture — see buildRoomParts's per-wall colours below for the
// safe way to make each wall visually distinct instead.
function addRoomLight() {}

function removeRoomLight(roomId) {
  const light = roomLights.get(roomId);
  if (!light) return;
  light.parent?.remove(light);
  roomLights.delete(roomId);
}

// Builds the 6 meshes for one room spec, already offset by `center` and
// tagged for the registry — callers still need to registerObject() each one.
function buildRoomParts(params, roomId, center) {
  const { width, length, height } = params;
  const roomMeta = { roomId, roomParams: { ...params }, roomCenter: { x: center.x, y: center.y, z: center.z } };
  const parts = [];

  const floorGeom = new THREE.BoxGeometry(width, WALL_THICKNESS, length);
  const floorMesh = new THREE.Mesh(floorGeom, createPaintMaterial('#c9c3b3'));
  floorMesh.position.set(center.x, center.y - WALL_THICKNESS / 2, center.z);
  floorMesh.receiveShadow = true;
  parts.push({ kind: 'roomFloor', mesh: floorMesh, extra: { ...roomMeta } });

  const ceilGeom = new THREE.BoxGeometry(width, WALL_THICKNESS, length);
  const ceilMesh = new THREE.Mesh(ceilGeom, createPaintMaterial('#f2f0ea'));
  ceilMesh.position.set(center.x, center.y + height + WALL_THICKNESS / 2, center.z);
  ceilMesh.receiveShadow = true;
  parts.push({ kind: 'roomCeiling', mesh: ceilMesh, extra: { ...roomMeta } });

  const hw = width / 2, hl = length / 2;
  const wallDefs = [
    { p1: { x: -hw, z: -hl }, p2: { x: hw, z: -hl } },
    { p1: { x: hw, z: -hl }, p2: { x: hw, z: hl } },
    { p1: { x: hw, z: hl }, p2: { x: -hw, z: hl } },
    { p1: { x: -hw, z: hl }, p2: { x: -hw, z: -hl } },
  ];
  // Four distinct flat paint colours, one per wall, muted enough to still
  // read as one coherent room — plain createPaintMaterial like every other
  // object's colour, nothing dynamic, so this can't be a source of the
  // rendering-noise regression the per-room light turned out to be. Lets
  // "the left wall" etc. be told apart at a glance without needing to tap
  // each one; any wall's colour can still be repainted individually from
  // its own selection panel afterward.
  const ROOM_WALL_COLORS = ['#d8c9b0', '#b0c4d8', '#c0d0b0', '#d0b8c0'];
  wallDefs.forEach((w, i) => {
    const dx = w.p2.x - w.p1.x, dz = w.p2.z - w.p1.z;
    const len = Math.hypot(dx, dz);
    const wallGeom = new THREE.BoxGeometry(len, height, WALL_THICKNESS);
    const wallMesh = new THREE.Mesh(wallGeom, createPaintMaterial(ROOM_WALL_COLORS[i % ROOM_WALL_COLORS.length]));
    wallMesh.position.set(center.x + (w.p1.x + w.p2.x) / 2, center.y + height / 2, center.z + (w.p1.z + w.p2.z) / 2);
    wallMesh.rotation.y = Math.atan2(-dz, dx);
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    parts.push({ kind: 'wall', mesh: wallMesh, extra: { ...roomMeta, wallLength: len } });
  });
  return parts;
}

function createRoom(params = DEFAULT_ROOM_PARAMS, center = new THREE.Vector3(0, 0, 0)) {
  const roomId = `room_${++roomCounter}_${Date.now().toString(36)}`;
  const parts = buildRoomParts(params, roomId, center);
  const records = parts.map((p) => registerObject(p.kind, p.mesh, p.extra));
  const wallRecord = records.find((r) => r.kind === 'wall');
  select(wallRecord || records[0]);
  addRoomLight(roomId, params, center);
  viewRoomInside(roomId);
  toast('Кімнату створено — розміри можна змінити в панелі об’єкта');
  return roomId;
}

// "Всередині" / "Зовні" — explicit camera jumps for the room popover, rather
// than trying to guess when to move the camera on the user's behalf. Reads
// the room's current params/centre back off its parts each time, so it
// stays correct across resizes.
function viewRoomInside(roomId) {
  const parts = findRoomParts(roomId);
  if (!parts.length) return;
  const { roomCenter: c } = parts[0];
  camera.position.set(c.x, c.y + EYE_HEIGHT, c.z);
  faceDirection(new THREE.Vector3(0, 0, -1));
  // Wider than the default FOV — standing at the centre of a small room is
  // only a metre or two from any wall, and the default angle crops it. The
  // +/- zoom control (setFov) still works from here for further adjustment.
  setFov(78);
}

function viewRoomOutside(roomId) {
  const parts = findRoomParts(roomId);
  if (!parts.length) return;
  const { roomParams: p, roomCenter: c } = parts[0];
  const span = Math.max(p.width, p.length, p.height);
  const offset = new THREE.Vector3(span * 0.9, span * 0.75 + p.height, span * 1.15);
  camera.position.set(c.x + offset.x, c.y + offset.y, c.z + offset.z);
  const lookAt = new THREE.Vector3(c.x, c.y + p.height / 2, c.z);
  faceDirection(lookAt.sub(camera.position).normalize());
  setFov(DEFAULT_FOV);
}

// Tears down every part of a room (including any tiles/grout placed on its
// walls/floor — they carry the same roomId) and rebuilds it fresh from a new
// spec, keeping the room centred where it was.
function rebuildRoom(roomId, newParams) {
  const existing = findRoomParts(roomId);
  if (!existing.length) return;
  const center = existing[0].roomCenter;
  const wasSelected = selected && existing.includes(selected);
  const centerVec = new THREE.Vector3(center.x, center.y, center.z);
  // buildRoomParts always emits parts in the same fixed order (floor,
  // ceiling, then the 4 walls) — capture each part's own paint/material by
  // that position so a resize doesn't quietly reset a wall someone painted.
  const savedMaterials = existing.map((r) => ({
    type: r.root.material.userData.creslarnetType,
    color: r.root.material.userData.creslarnetColor,
  }));
  existing.forEach(removeObject);
  const parts = buildRoomParts(newParams, roomId, centerVec);
  const records = parts.map((p, i) => {
    const saved = savedMaterials[i];
    if (saved) {
      p.mesh.material.dispose();
      p.mesh.material = saved.type === 'paint' ? createPaintMaterial(saved.color) : createMaterial(saved.type, saved.color, scene.environment);
    }
    return registerObject(p.kind, p.mesh, p.extra);
  });
  removeRoomLight(roomId);
  addRoomLight(roomId, newParams, centerVec);
  if (wasSelected) select(records.find((r) => r.kind === 'wall') || records[0]);
  else renderSelectionPanel();
}

function removeRoom(roomId) {
  findRoomParts(roomId).forEach(removeObject);
  removeRoomLight(roomId);
  toast('Кімнату видалено');
}

// The room-dimension editor — reused both in a room part's own selection
// panel and in the "Кімната" popover, so the two stay in sync automatically.
function buildRoomDimsSection(roomId) {
  const wrap = document.createElement('div');
  const parts = findRoomParts(roomId);
  if (!parts.length) return wrap;

  const title = document.createElement('p');
  title.className = 'panel-title';
  title.textContent = 'Розміри кімнати';
  wrap.appendChild(title);

  const section = document.createElement('div');
  section.className = 'size-section';
  const fields = [
    { key: 'width', label: 'Ширина' },
    { key: 'length', label: 'Довжина' },
    { key: 'height', label: 'Висота' },
  ];
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'size-row';
    const label = document.createElement('span');
    label.className = 'axis-label';
    label.textContent = f.label;

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

    const current = () => (findRoomParts(roomId)[0] || { roomParams: {} }).roomParams[f.key];
    const apply = (v) => {
      if (!Number.isFinite(v) || v < 500) { input.value = formatMm(current()); return; }
      const next = { ...findRoomParts(roomId)[0].roomParams, [f.key]: roundMm(v) };
      rebuildRoom(roomId, next);
    };
    input.value = formatMm(current());
    minus.addEventListener('click', () => apply(current() - 100));
    plus.addEventListener('click', () => apply(current() + 100));
    input.addEventListener('change', () => apply(parseFloat(input.value.replace(',', '.'))));

    row.append(label, minus, input, plus, unit);
    section.appendChild(row);
  }
  wrap.appendChild(section);

  const delBtn = document.createElement('button');
  delBtn.className = 'pbtn danger wide';
  delBtn.textContent = '🗑 Видалити кімнату';
  delBtn.addEventListener('click', () => { deselect(); removeRoom(roomId); });
  wrap.appendChild(delBtn);
  return wrap;
}

// ---------------------------------------------------------------------------
// "Плитка" (3D) — drag a rectangle on a wall or floor to mark the area to
// tile, then "Покласти плитку" fills the whole thing in one shot: full
// tiles wherever they fit, and an automatically-sized cut piece wherever
// they don't (tracked as tileRecord.tileCut and given its own on-model
// width/height callout — see updateTileCutLabels below), the same way a
// real tiler works out a layout before cutting anything.
// ---------------------------------------------------------------------------
const TILE_THICKNESS = 8; // mm

// A wall's local frame runs (length, height, thickness) along (X, Y, Z); a
// floor/ceiling's runs (width, thickness, length) along (X, Y, Z) — so the
// "along the surface" axes are (X,Y) for a wall but (X,Z) for a floor/ceiling,
// and the "outward" axis is Z for a wall but Y for a floor/ceiling.
function isWallLike(kind) { return kind === 'wall'; }
function surfaceUV(kind, local) {
  return isWallLike(kind) ? { u: local.x, v: local.y } : { u: local.x, v: local.z };
}
function surfaceLocalFromUV(kind, u, v, normalOffset) {
  return isWallLike(kind)
    ? new THREE.Vector3(u, v, normalOffset)
    : new THREE.Vector3(u, normalOffset, v);
}
function surfaceFaceSign(kind, local) {
  return isWallLike(kind) ? (local.z >= 0 ? 1 : -1) : (local.y >= 0 ? 1 : -1);
}
function buildTileGeometry(kind, w, h, thickness) {
  return isWallLike(kind) ? new THREE.BoxGeometry(w, h, thickness) : new THREE.BoxGeometry(w, thickness, h);
}

// Mirrors the 2D "Плитка" grid-fill algorithm (computeTileGrid in
// script.js): step across the area in tile-size increments, cropping
// whatever's left at the far edge instead of overflowing it, so the layout
// always fits the exact area the user dragged out.
function computeTileCells(areaW, areaH, tileW, tileH, grout) {
  const stepU = tileW + grout, stepV = tileH + grout;
  const us = [];
  for (let u = 0; u < areaW - 0.01; u += stepU) us.push(u);
  const vs = [];
  for (let v = 0; v < areaH - 0.01; v += stepV) vs.push(v);
  const cells = [];
  for (const v of vs) {
    for (const u of us) {
      const w = Math.min(tileW, areaW - u);
      const h = Math.min(tileH, areaH - v);
      cells.push({ u, v, w, h, isFull: w >= tileW - 0.05 && h >= tileH - 0.05 });
    }
  }
  return cells;
}

let tileDrag = null;           // { record, faceSign, startUV: {u,v} } while actively dragging
let tileArea = null;           // { record, faceSign, u0, v0, u1, v1 } finalized, awaiting the button
let tileAreaPreviewMesh = null;

function beginTileAreaDrag(record, worldPoint) {
  const local = record.root.worldToLocal(worldPoint.clone());
  tileDrag = { record, faceSign: surfaceFaceSign(record.kind, local), startUV: surfaceUV(record.kind, local) };
}

function updateTileAreaDrag(worldPoint) {
  if (!tileDrag) return;
  const local = tileDrag.record.root.worldToLocal(worldPoint.clone());
  const uv = surfaceUV(tileDrag.record.kind, local);
  paintTileAreaPreview(tileDrag.record, tileDrag.faceSign, tileDrag.startUV, uv);
}

function endTileAreaDrag(worldPoint) {
  if (!tileDrag) return;
  const { record, faceSign, startUV } = tileDrag;
  const local = record.root.worldToLocal(worldPoint.clone());
  const uv = surfaceUV(record.kind, local);
  tileDrag = null;
  const u0 = Math.min(startUV.u, uv.u), u1 = Math.max(startUV.u, uv.u);
  const v0 = Math.min(startUV.v, uv.v), v1 = Math.max(startUV.v, uv.v);
  if (u1 - u0 < 30 || v1 - v0 < 30) {
    clearTileAreaPreview();
    toast('Ділянка занадто мала — розтягніть більшу область');
    renderTilePill();
    return;
  }
  tileArea = { record, faceSign, u0, v0, u1, v1 };
  paintTileAreaPreview(record, faceSign, { u: u0, v: v0 }, { u: u1, v: v1 });
  renderTilePill();
}

function cancelTileArea() {
  tileDrag = null;
  tileArea = null;
  clearTileAreaPreview();
}

// Translucent purple slab standing just off the surface — the same
// "selected area" affordance as everywhere else in the app, live during
// the drag and left up until the user commits or cancels.
function paintTileAreaPreview(record, faceSign, uvA, uvB) {
  clearTileAreaPreview();
  const kind = record.kind;
  const w = Math.abs(uvB.u - uvA.u), h = Math.abs(uvB.v - uvA.v);
  if (w < 1 || h < 1) return;
  const u0 = Math.min(uvA.u, uvB.u), v0 = Math.min(uvA.v, uvB.v);
  const geom = buildTileGeometry(kind, w, h, 4);
  const mat = new THREE.MeshBasicMaterial({ color: 0x8338ec, transparent: true, opacity: 0.32, depthTest: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  const localOffset = faceSign * (WALL_THICKNESS / 2 + 6);
  mesh.position.copy(record.root.localToWorld(surfaceLocalFromUV(kind, u0 + w / 2, v0 + h / 2, localOffset)));
  mesh.quaternion.copy(record.root.quaternion);
  mesh.renderOrder = 999;
  scene.add(mesh);
  tileAreaPreviewMesh = mesh;
}

function clearTileAreaPreview() {
  if (!tileAreaPreviewMesh) return;
  tileAreaPreviewMesh.parent?.remove(tileAreaPreviewMesh);
  tileAreaPreviewMesh.geometry.dispose();
  tileAreaPreviewMesh.material.dispose();
  tileAreaPreviewMesh = null;
}

function commitTileArea() {
  if (!tileArea) return;
  const { record, faceSign, u0, v0, u1, v1 } = tileArea;
  const kind = record.kind, mesh = record.root;
  const areaW = u1 - u0, areaH = v1 - v0;
  const cells = computeTileCells(areaW, areaH, tileConfig.w, tileConfig.h, tileConfig.grout);
  const extra = record.roomId ? { roomId: record.roomId } : {};

  // One grout-coloured backing plate sized to the exact selected area (not
  // the whole wall), so the gap between tiles shows grout, not raw wall.
  const backingGeom = buildTileGeometry(kind, areaW, areaH, 2);
  const backingMesh = new THREE.Mesh(backingGeom, createPaintMaterial(tileConfig.groutColor));
  const backingLocalOffset = faceSign * (WALL_THICKNESS / 2 + 1);
  backingMesh.position.copy(mesh.localToWorld(surfaceLocalFromUV(kind, u0 + areaW / 2, v0 + areaH / 2, backingLocalOffset)));
  backingMesh.quaternion.copy(mesh.quaternion);
  backingMesh.receiveShadow = true;
  registerObject('tileGrout', backingMesh, extra);

  let cutCount = 0;
  for (const cell of cells) {
    const cu = u0 + cell.u + cell.w / 2, cv = v0 + cell.v + cell.h / 2;
    const localOffset = faceSign * (WALL_THICKNESS / 2 + TILE_THICKNESS / 2 + 1);
    const localPos = surfaceLocalFromUV(kind, cu, cv, localOffset);
    const tileGeom = buildTileGeometry(kind, cell.w, cell.h, TILE_THICKNESS);
    const tileMesh = new THREE.Mesh(tileGeom, createPaintMaterial(tileConfig.color));
    tileMesh.position.copy(mesh.localToWorld(localPos));
    tileMesh.quaternion.copy(mesh.quaternion);
    tileMesh.castShadow = true;
    tileMesh.receiveShadow = true;
    const tileRecord = registerObject('tile', tileMesh, extra);
    if (!cell.isFull) { tileRecord.tileCut = { w: cell.w, h: cell.h, wallLike: isWallLike(kind) }; cutCount++; }
  }

  toast(`Покладено ${cells.length} плиток${cutCount ? `, з них ${cutCount} обрізаних — розміри підписані на них` : ''}`);
  tileArea = null;
  clearTileAreaPreview();
  // Tool stays active — tiling a whole room is usually more than one
  // dragged area (around a window, up to a doorway, …), so the pill goes
  // back to "drag the next area" instead of closing.
  renderTilePill();
}

function renderTilePill() {
  modePillEl.innerHTML = '';
  if (tileArea) {
    const label = document.createElement('span');
    label.textContent = `Ділянка ${formatMm(tileArea.u1 - tileArea.u0, 0)} × ${formatMm(tileArea.v1 - tileArea.v0, 0)} мм`;
    const lay = document.createElement('button');
    lay.textContent = '✓ Покласти плитку';
    lay.addEventListener('click', commitTileArea);
    const cancel = document.createElement('button');
    cancel.textContent = '✕ Скасувати';
    cancel.addEventListener('click', () => { cancelTileArea(); renderTilePill(); });
    modePillEl.append(label, lay, cancel);
  } else {
    const label = document.createElement('span');
    label.textContent = 'Розтягніть прямокутну ділянку на стіні чи підлозі';
    const done = document.createElement('button');
    done.textContent = '✓ Готово';
    done.addEventListener('click', () => { tileToolActive = false; cancelTileArea(); hideEl(modePillEl); });
    modePillEl.append(label, done);
  }
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

// ---------------------------------------------------------------------------
// "Просторова лінія" — a polyline drawn freely in 3D space (not confined to
// a paper sheet), point by point, with a small gizmo instead of a flat
// drag: six one-way arrows (up/down/left/right/forward/back) extend the
// line along a world axis from wherever it currently ends, and a rotation
// ring aims a seventh "custom angle" arrow anywhere in the horizontal
// plane — softly snapping every 15° — for a run that doesn't sit strictly
// on-axis (a 45° diagonal, say). Finished, it's a `spatialLine` you select
// and convert into a pipe, an electrical wire (any of the usual wire
// colours), or rebar — each becomes one multi-segment run with its own
// colour and a small always-on label naming what it is.
// ---------------------------------------------------------------------------
let spatialLineActive = false;
let spatialLineDraft = null;          // { points: [Vector3, ...] } while drawing
let spatialLineGizmo = null;          // THREE.Group at the last committed point
let spatialLineGizmoTargets = [];     // hit-test meshes tagged userData.slAxis or .slRing
let spatialLineGizmoCustomGroup = null; // the rotating "custom angle" arrow, child of the gizmo
let spatialLineDrag = null;           // { axisWorld, basePoint, candidatePoint, length } while extending
let spatialLineRingDrag = null;       // { centerScreen, prevAngle } while aiming the custom arrow
let spatialLineCustomAngle = 0;       // radians, current custom-arrow angle in the XZ plane
let spatialLinePreviewMesh = null;    // thin line covering committed + in-progress segments

const SL_AXIS_DIRS = {
  x: new THREE.Vector3(1, 0, 0), negx: new THREE.Vector3(-1, 0, 0),
  y: new THREE.Vector3(0, 1, 0), negy: new THREE.Vector3(0, -1, 0),
  z: new THREE.Vector3(0, 0, 1), negz: new THREE.Vector3(0, 0, -1),
};

function roundVec(v) { return new THREE.Vector3(roundMm(v.x), roundMm(v.y), roundMm(v.z)); }

function spatialLineCustomDir() {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spatialLineCustomAngle);
  return new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
}

// Six unidirectional arrows (not three bidirectional axes — the user aims
// one arrow at a time, so a separate mesh per direction keeps the hit-test
// unambiguous) plus a rotation ring and the custom-angle arrow it aims.
const SPATIAL_LINE_GIZMO_SIZE = 280; // mm — fixed, there's no "selected object" to size against here
function buildSpatialLineGizmo() {
  const group = new THREE.Group();
  group.userData.isHelper = true;
  const targets = [];
  const size = SPATIAL_LINE_GIZMO_SIZE;
  const shaftLen = size * 0.9, shaftR = size * 0.05, headLen = size * 0.3, headR = size * 0.13;
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false });

  const AXES = [
    { key: 'x', dir: SL_AXIS_DIRS.x, color: AXIS_COLOR.x },
    { key: 'negx', dir: SL_AXIS_DIRS.negx, color: AXIS_COLOR.x },
    { key: 'y', dir: SL_AXIS_DIRS.y, color: AXIS_COLOR.y },
    { key: 'negy', dir: SL_AXIS_DIRS.negy, color: AXIS_COLOR.y },
    { key: 'z', dir: SL_AXIS_DIRS.z, color: AXIS_COLOR.z },
    { key: 'negz', dir: SL_AXIS_DIRS.negz, color: AXIS_COLOR.z },
  ];
  for (const axis of AXES) {
    const mat = new THREE.MeshBasicMaterial({ color: axis.color, depthTest: false, transparent: true, opacity: 0.95 });
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 10), mat);
    shaft.position.y = shaftLen / 2;
    shaft.renderOrder = 999;
    const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 10), mat);
    head.position.y = shaftLen + headLen / 2;
    head.renderOrder = 999;
    arrow.add(shaft, head);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.dir);
    shaft.userData.isHelper = true; head.userData.isHelper = true;

    const shaftHit = new THREE.Mesh(new THREE.CylinderGeometry(shaftR * 3.5, shaftR * 3.5, shaftLen, 8), hitMat);
    shaftHit.position.y = shaftLen / 2;
    const headHit = new THREE.Mesh(new THREE.ConeGeometry(headR * 1.5, headLen * 1.3, 8), hitMat);
    headHit.position.y = shaftLen + headLen / 2;
    shaftHit.userData.slAxis = axis.key; headHit.userData.slAxis = axis.key;
    shaftHit.userData.isHelper = true; headHit.userData.isHelper = true;
    arrow.add(shaftHit, headHit);
    targets.push(shaftHit, headHit);
    group.add(arrow);
  }

  // Rotation ring (horizontal plane) — aims the custom-angle arrow below.
  const ringR = size * 0.75, tubeR = size * 0.045;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x8338ec, depthTest: false, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ringR, tubeR, 8, 48), ringMat);
  ring.rotateX(-Math.PI / 2);
  ring.userData.isHelper = true;
  group.add(ring);
  const ringHit = new THREE.Mesh(new THREE.TorusGeometry(ringR, tubeR * 4, 8, 48), hitMat);
  ringHit.rotateX(-Math.PI / 2);
  ringHit.userData.slRing = true;
  ringHit.userData.isHelper = true;
  group.add(ringHit);
  targets.push(ringHit);

  // Custom-angle arrow (purple) — orientation kept in sync with
  // spatialLineCustomAngle by updateSpatialLineCustomArrow().
  const customGroup = new THREE.Group();
  const customMat = new THREE.MeshBasicMaterial({ color: 0x8338ec, depthTest: false, transparent: true, opacity: 0.95 });
  const customShaftLen = size * 0.65;
  const customShaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, customShaftLen, 10), customMat);
  customShaft.position.y = customShaftLen / 2;
  customShaft.renderOrder = 999;
  const customHead = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 10), customMat);
  customHead.position.y = customShaftLen + headLen / 2;
  customHead.renderOrder = 999;
  customGroup.add(customShaft, customHead);
  customShaft.userData.isHelper = true; customHead.userData.isHelper = true;
  const customShaftHit = new THREE.Mesh(new THREE.CylinderGeometry(shaftR * 3.5, shaftR * 3.5, customShaftLen, 8), hitMat);
  customShaftHit.position.y = customShaftLen / 2;
  const customHeadHit = new THREE.Mesh(new THREE.ConeGeometry(headR * 1.5, headLen * 1.3, 8), hitMat);
  customHeadHit.position.y = customShaftLen + headLen / 2;
  customShaftHit.userData.slAxis = 'custom'; customHeadHit.userData.slAxis = 'custom';
  customShaftHit.userData.isHelper = true; customHeadHit.userData.isHelper = true;
  customGroup.add(customShaftHit, customHeadHit);
  targets.push(customShaftHit, customHeadHit);
  group.add(customGroup);

  return { group, targets, customGroup };
}

function updateSpatialLineCustomArrow() {
  if (!spatialLineGizmoCustomGroup) return;
  spatialLineGizmoCustomGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), spatialLineCustomDir());
}

function attachSpatialLineGizmo(point) {
  detachSpatialLineGizmo();
  const built = buildSpatialLineGizmo();
  spatialLineGizmo = built.group;
  spatialLineGizmoTargets = built.targets;
  spatialLineGizmoCustomGroup = built.customGroup;
  spatialLineGizmo.position.copy(point);
  scene.add(spatialLineGizmo);
  updateSpatialLineCustomArrow();
}

function detachSpatialLineGizmo() {
  if (!spatialLineGizmo) return;
  spatialLineGizmo.parent?.remove(spatialLineGizmo);
  spatialLineGizmo.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  spatialLineGizmo = null;
  spatialLineGizmoTargets = [];
  spatialLineGizmoCustomGroup = null;
}

function beginSpatialLineDrag(axisKey, ray) {
  const axisWorld = axisKey === 'custom' ? spatialLineCustomDir() : SL_AXIS_DIRS[axisKey].clone();
  const basePoint = spatialLineGizmo.position.clone();
  const startPoint = closestPointOnLineToRay(basePoint, axisWorld, ray.ray.origin, ray.ray.direction);
  spatialLineDrag = { axisWorld, basePoint, startPoint, candidatePoint: basePoint.clone(), length: 0 };
}

function updateSpatialLineDrag(ray) {
  const g = spatialLineDrag;
  const newPoint = closestPointOnLineToRay(g.basePoint, g.axisWorld, ray.ray.origin, ray.ray.direction);
  // Only the positive direction along this specific arrow's axis counts —
  // each of the six arrows already only points one way.
  const offset = Math.max(0, new THREE.Vector3().subVectors(newPoint, g.basePoint).dot(g.axisWorld));
  g.candidatePoint = g.basePoint.clone().addScaledVector(g.axisWorld, offset);
  g.length = offset;
  updateSpatialLinePreview();
  updateSpatialLineLengthLabel(g.basePoint, g.candidatePoint, g.length);
}

function endSpatialLineDrag() {
  const g = spatialLineDrag;
  spatialLineDrag = null;
  hideSpatialLineLengthLabel();
  if (!g || g.length < 10) { updateSpatialLinePreview(); return; } // ignore a near-zero/no-op drag
  const point = roundVec(g.candidatePoint);
  spatialLineDraft.points.push(point);
  attachSpatialLineGizmo(point);
  updateSpatialLinePreview();
  renderSpatialLinePill();
}

// Softly snaps to every 15° (so 45°, 90°… are easy to hit exactly) once
// within 3° of one, otherwise leaves the angle exactly where dragged.
function snapAngleRad(rad) {
  const deg = (rad * 180) / Math.PI;
  const nearest = Math.round(deg / 15) * 15;
  return Math.abs(deg - nearest) <= 3 ? (nearest * Math.PI) / 180 : rad;
}

function beginSpatialLineRingDrag(clientX, clientY) {
  const centerScreen = projectToScreenPx(spatialLineGizmo.position);
  spatialLineRingDrag = { centerScreen, prevAngle: Math.atan2(clientY - centerScreen.y, clientX - centerScreen.x) };
}

function updateSpatialLineRingDrag(clientX, clientY) {
  const g = spatialLineRingDrag;
  const angle = Math.atan2(clientY - g.centerScreen.y, clientX - g.centerScreen.x);
  let step = angle - g.prevAngle;
  if (step > Math.PI) step -= Math.PI * 2;
  if (step < -Math.PI) step += Math.PI * 2;
  g.prevAngle = angle;
  spatialLineCustomAngle = snapAngleRad(spatialLineCustomAngle + step * ROTATE_DRAG_SENSITIVITY);
  updateSpatialLineCustomArrow();
}

function updateSpatialLinePreview() {
  clearSpatialLinePreview();
  if (!spatialLineDraft) return;
  const pts = spatialLineDraft.points.slice();
  if (spatialLineDrag) pts.push(spatialLineDrag.candidatePoint);
  if (pts.length < 2) return;
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x8338ec, depthTest: false });
  const line = new THREE.Line(geom, mat);
  line.renderOrder = 998;
  scene.add(line);
  spatialLinePreviewMesh = line;
}

function clearSpatialLinePreview() {
  if (!spatialLinePreviewMesh) return;
  spatialLinePreviewMesh.parent?.remove(spatialLinePreviewMesh);
  spatialLinePreviewMesh.geometry.dispose();
  spatialLinePreviewMesh.material.dispose();
  spatialLinePreviewMesh = null;
}

// Same NDC->pixel projection as the axis-rotate gizmo (projectToScreenPx)
// and the same pattern updateAxisLabels/updateHoleLabels use for their own
// SVG overlays — kept local here rather than factored out, to match.
function slProjectToScreen(v) {
  const ndc = v.clone().project(camera);
  return { x: (ndc.x * 0.5 + 0.5) * window.innerWidth, y: (-ndc.y * 0.5 + 0.5) * window.innerHeight, behind: ndc.z < -1 || ndc.z > 1 };
}

const spatialLineLengthGroupEl = document.getElementById('spatialLineLengthGroup');
const spatialLineLengthLineEl = spatialLineLengthGroupEl.querySelector('.spatial-line-length-line');
const spatialLineLengthTextEl = spatialLineLengthGroupEl.querySelector('.spatial-line-length-text');

function updateSpatialLineLengthLabel(aWorld, bWorld, lengthMm) {
  const a = slProjectToScreen(aWorld), b = slProjectToScreen(bWorld);
  if (a.behind || b.behind) { hideSpatialLineLengthLabel(); return; }
  spatialLineLengthLineEl.setAttribute('x1', a.x); spatialLineLengthLineEl.setAttribute('y1', a.y);
  spatialLineLengthLineEl.setAttribute('x2', b.x); spatialLineLengthLineEl.setAttribute('y2', b.y);
  spatialLineLengthTextEl.setAttribute('x', (a.x + b.x) / 2);
  spatialLineLengthTextEl.setAttribute('y', (a.y + b.y) / 2 - 14);
  spatialLineLengthTextEl.textContent = `${formatMm(lengthMm, 0)} мм`;
  spatialLineLengthGroupEl.classList.remove('hidden');
}
function hideSpatialLineLengthLabel() {
  spatialLineLengthGroupEl.classList.add('hidden');
}

function renderSpatialLinePill() {
  modePillEl.innerHTML = '';
  const label = document.createElement('span');
  const n = spatialLineDraft ? spatialLineDraft.points.length : 0;
  label.textContent = spatialLineGizmo
    ? `Точок: ${n} — тягніть стрілку гізмо або кільце для кута`
    : 'Торкніться, щоб поставити першу точку';
  modePillEl.appendChild(label);

  if (spatialLineDraft && spatialLineDraft.points.length > 1) {
    const undoBtn = document.createElement('button');
    undoBtn.textContent = '⌫ Точка';
    undoBtn.addEventListener('click', () => {
      spatialLineDraft.points.pop();
      attachSpatialLineGizmo(spatialLineDraft.points[spatialLineDraft.points.length - 1]);
      updateSpatialLinePreview();
      renderSpatialLinePill();
    });
    modePillEl.appendChild(undoBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ Скасувати';
  cancelBtn.addEventListener('click', cancelSpatialLine);
  modePillEl.appendChild(cancelBtn);

  if (spatialLineDraft && spatialLineDraft.points.length >= 2) {
    const doneBtn = document.createElement('button');
    doneBtn.textContent = '✓ Завершити';
    doneBtn.addEventListener('click', finishSpatialLine);
    modePillEl.appendChild(doneBtn);
  }
  showEl(modePillEl);
}

function cancelSpatialLine() {
  spatialLineActive = false;
  spatialLineDraft = null;
  spatialLineDrag = null;
  spatialLineRingDrag = null;
  detachSpatialLineGizmo();
  clearSpatialLinePreview();
  hideSpatialLineLengthLabel();
  hideEl(modePillEl);
  document.getElementById('spatialLineFab')?.classList.remove('on');
}

// Reuses the sketch-line conversion geometry (pipe/rebar build along local
// +X, same as CONVERT_DEFS above) but walks every segment of a multi-point
// run instead of just one, and adds "провід" with a colour of its own.
// isPipe is deliberately left off — attachSelectedPipe assumes a single
// mesh with its own .geometry, and a converted run here is a Group.
const SPATIAL_LINE_RUN_DEFS = {
  pipe: { buildGeometry: CONVERT_DEFS.pipe.buildGeometry, buildMaterial: CONVERT_DEFS.pipe.buildMaterial, label: () => KIND_LABELS.pipe },
  rebar: { buildGeometry: CONVERT_DEFS.rebar.buildGeometry, buildMaterial: CONVERT_DEFS.rebar.buildMaterial, label: () => KIND_LABELS.rebar },
  wire: {
    buildGeometry: (length) => { const g = new THREE.CylinderGeometry(4, 4, length, 10); g.rotateZ(Math.PI / 2); return g; },
    buildMaterial: (color) => createPaintMaterial(color),
    label: (color) => `${KIND_LABELS.wire} · ${(WIRE_COLORS.find((w) => w.color === color) || {}).name || ''}`,
  },
};

// Shared by finishSpatialLine, convertSpatialLine, and the save/load
// reconstruction below (buildObjectFromItem) — one segment mesh per pair
// of consecutive points, `kind` either 'spatialLine' (the raw draft look —
// a fixed purple) or one of SPATIAL_LINE_RUN_DEFS's converted types.
function buildSpatialLineRunGroup(points, kind, color) {
  const def = SPATIAL_LINE_RUN_DEFS[kind]; // undefined for the raw draft
  const rawMat = def ? null : createPaintMaterial('#8338ec');
  const group = new THREE.Group();
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dir = new THREE.Vector3().subVectors(b, a);
    const length = dir.length();
    if (length < 1) continue;
    dir.normalize();
    let geom, mat;
    if (def) {
      geom = def.buildGeometry(length);
      mat = def.buildMaterial(color);
    } else {
      geom = new THREE.CylinderGeometry(5, 5, length, 8);
      geom.rotateZ(Math.PI / 2); // local +Y (cylinder's own axis) -> local +X, matching CONVERT_DEFS's convention
      mat = rawMat;
    }
    const mesh = new THREE.Mesh(geom, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    totalLen += length;
  }
  return { group, totalLen };
}

function finishSpatialLine() {
  if (!spatialLineDraft || spatialLineDraft.points.length < 2) { cancelSpatialLine(); return; }
  const points = spatialLineDraft.points;
  const { group, totalLen } = buildSpatialLineRunGroup(points, 'spatialLine', null);
  if (!group.children.length) { toast('Лінія замала для збереження'); cancelSpatialLine(); return; }

  const record = registerObject('spatialLine', group, { spatialLinePoints: points.map((p) => p.clone()) });
  spatialLineActive = false;
  spatialLineDraft = null;
  detachSpatialLineGizmo();
  clearSpatialLinePreview();
  hideSpatialLineLengthLabel();
  hideEl(modePillEl);
  document.getElementById('spatialLineFab')?.classList.remove('on');
  select(record);
  toast(`Лінію завершено — ${points.length} точок, ${formatMm(totalLen, 0)} мм. Оберіть, у що перетворити.`);
}

function convertSpatialLine(record, targetKind, color) {
  const def = SPATIAL_LINE_RUN_DEFS[targetKind];
  const points = record.spatialLinePoints;
  if (!points || points.length < 2) { toast('Немає даних лінії для перетворення'); return; }

  const { group } = buildSpatialLineRunGroup(points, targetKind, color);
  if (!group.children.length) { toast('Лінія замала для перетворення'); return; }

  const runLabel = def.label(color);
  removeObject(record);
  const newRecord = registerObject(targetKind, group, { spatialLinePoints: points.map((p) => p.clone()), runLabel, runColor: color });
  select(newRecord);
  toast(`Перетворено на: ${runLabel}`);
}

const spatialLineLabelsGroupEl = document.getElementById('spatialLineLabelsGroup');
function updateSpatialLineTypeLabels() {
  const runs = mode === 'edit' ? objects.filter((r) => r.runLabel) : [];
  if (!runs.length) {
    if (spatialLineLabelsGroupEl.childElementCount) spatialLineLabelsGroupEl.innerHTML = '';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const rec of runs) {
    const pts = rec.spatialLinePoints;
    if (!pts || !pts.length) continue;
    const mid = pts[Math.floor(pts.length / 2)];
    const s = slProjectToScreen(mid);
    if (s.behind) continue;
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'pipe-run-label');
    text.setAttribute('x', s.x);
    text.setAttribute('y', s.y - 16);
    text.textContent = rec.runLabel;
    frag.appendChild(text);
  }
  spatialLineLabelsGroupEl.innerHTML = '';
  spatialLineLabelsGroupEl.appendChild(frag);
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
// A ring of straight segments approximating a circle of the given radius,
// in the local XZ-plane at height y — building block for the round-object
// outlines below (returned as a flat [x,y,z, x,y,z, …] pair list, ready for
// a LineSegments position attribute).
function circleOutlinePoints(radius, y, segments = 48) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    pts.push(radius * Math.cos(a0), y, radius * Math.sin(a0), radius * Math.cos(a1), y, radius * Math.sin(a1));
  }
  return pts;
}

// EdgesGeometry is honest for sharp-edged shapes (a cube's 90° corners) but
// on a round primitive it picks up every facet-to-facet seam around the
// curved surface (only ~11° apart on a 32-segment cylinder) — the "chaotic
// lines all over the surface" look. Cylinder/cone/pipe get a hand-built
// outline instead: the real rim circle(s) plus two side lines, matching how
// a technical drawing depicts a round solid. Base dimensions are each
// kind's own fixed build size (KIND_DEFS/buildPipeGeometry) — resizing
// afterward goes through record.root.scale, which this outline inherits
// for free as a child, same as the EdgesGeometry path.
function buildRoundOutlineGeometry(kind) {
  let positions;
  if (kind === 'cylinder') {
    positions = [
      ...circleOutlinePoints(500, 500),
      ...circleOutlinePoints(500, -500),
      500, 500, 0, 500, -500, 0,
      -500, 500, 0, -500, -500, 0,
    ];
  } else if (kind === 'cone') {
    positions = [
      ...circleOutlinePoints(500, -500),
      500, -500, 0, 0, 500, 0,
      -500, -500, 0, 0, 500, 0,
    ];
  } else if (kind === 'pipe') {
    // buildPipeGeometry's own local frame: extrusion runs along local X from
    // 0 to `length`, cross-section (radius outerR) centred in the YZ-plane.
    const outerR = 220, length = 1400;
    positions = [];
    const ringAt = (x) => {
      const pts = [];
      for (let i = 0; i < 48; i++) {
        const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
        pts.push(x, outerR * Math.cos(a0), outerR * Math.sin(a0), x, outerR * Math.cos(a1), outerR * Math.sin(a1));
      }
      return pts;
    };
    positions.push(...ringAt(0), ...ringAt(length));
    positions.push(0, outerR, 0, length, outerR, 0);
    positions.push(0, -outerR, 0, length, -outerR, 0);
  } else {
    return null;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

let outlineHelper = null;
function select(record) {
  if (selected === record) return;
  deselect();
  selected = record;
  if (record.roomId) activeRoomId = record.roomId;

  const roundOutline = record.root.isMesh ? buildRoundOutlineGeometry(record.kind) : null;
  if (record.kind === 'ground') {
    // no outline on an 80 m plane — a box around it isn't useful
  } else if (record.kind === 'window') {
    // a window really is boxy — BoxHelper is the honest shape for it
    outlineHelper = new THREE.BoxHelper(record.root, 0x8338ec);
    scene.add(outlineHelper);
  } else if (roundOutline) {
    outlineHelper = new THREE.LineSegments(roundOutline, new THREE.LineBasicMaterial({ color: 0x8338ec }));
    outlineHelper.update = () => {};
    record.root.add(outlineHelper);
  } else if (record.root.isMesh) {
    // Hugs the object's own silhouette (sharp for a cube/wall/beam) —
    // geometry edges beyond a small angle threshold, added as a child so it
    // tracks transform for free.
    const edges = new THREE.EdgesGeometry(record.root.geometry, 10);
    outlineHelper = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x8338ec }));
    outlineHelper.update = () => {}; // no-op — kept so existing outlineHelper?.update() call sites stay valid
    record.root.add(outlineHelper);
  } else {
    // A compound (or any other future multi-part group) — boxy is the
    // honest shape for an assembly, same as a window.
    outlineHelper = new THREE.BoxHelper(record.root, 0x8338ec);
    scene.add(outlineHelper);
  }

  if (record.kind !== 'ground' && record.kind !== 'sketchLine') {
    const built = buildGizmo(record);
    gizmo = built.group;
    gizmoMoveTargets = built.moveTargets;
    gizmoRotateTargets = built.rotateTargets;
    record.root.add(gizmo); // child — tracks position/rotation/scale for free
  }
  closePopover();
  renderSelectionPanel();
}

function deselect() {
  if (outlineHelper) {
    outlineHelper.parent?.remove(outlineHelper);
    outlineHelper.geometry?.dispose();
    outlineHelper.material?.dispose();
    outlineHelper = null;
  }
  removeGizmo();
  hideDimensionOverlay();
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

// Local-space bounding box for any record.root, mesh or group — a plain
// mesh just reports its own geometry box; a group (window, compound) unions
// each part's own box offset by the part's local position. Parts are simple
// primitives with no nested rotation in practice, so this stays accurate
// enough for sizing/gizmo/explode purposes without a full matrix walk.
function localBoundingBox(root) {
  if (root.isMesh) {
    root.geometry.computeBoundingBox(); // cheap; re-run in case CSG just replaced the geometry
    return root.geometry.boundingBox.clone();
  }
  const box = new THREE.Box3();
  for (const child of root.children) {
    if (!child.isMesh || child.userData.isHelper) continue;
    child.geometry.computeBoundingBox();
    const childBox = child.geometry.boundingBox.clone();
    childBox.min.multiply(child.scale).add(child.position);
    childBox.max.multiply(child.scale).add(child.position);
    box.union(childBox);
  }
  return box;
}

// Intrinsic size (local-space bounding box × scale) — the object's own
// width/height/depth regardless of how it's rotated in the world, matching
// what "this cube is 200 mm" should mean.
function getObjectSizeMm(record) {
  if (record.kind === 'window') {
    const p = record.root.userData.windowParams;
    return new THREE.Vector3(p.width, p.height, p.thickness).multiply(record.root.scale);
  }
  const size = localBoundingBox(record.root).getSize(new THREE.Vector3());
  size.multiply(record.root.scale);
  return size;
}

// The local (unscaled) half-extent to size the AxesHelper — as a child of
// the object it inherits the object's own scale, so this length grows or
// shrinks automatically as the object is resized without touching the
// helper again.
function axisGizmoLocalSize(record) {
  if (record.kind === 'window') {
    const p = record.root.userData.windowParams;
    return Math.max(p.width, p.height, p.thickness) * 0.6;
  }
  const size = localBoundingBox(record.root).getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z) * 0.6;
}

// ---------------------------------------------------------------------------
// Move + rotate gizmo — real 3D handles on the selected object (both
// children of record.root, so they track its transform for free):
//   - three thick arrows along local X/Y/Z: drag one to slide the object
//     along that single axis (closest-point-between-two-lines math, the
//     standard technique — robust from any camera angle).
//   - three rings (a torus per axis, 3ds Max style): drag one to spin the
//     object around that local axis, angle tracked in the ring's own plane.
// Built once per selection at whatever size fits the object; since both
// live under the object as children, resizing it afterward stretches them
// along with it with no extra bookkeeping.
// ---------------------------------------------------------------------------
let gizmo = null;              // THREE.Group, child of selected.root
let gizmoMoveTargets = [];     // meshes tagged with userData.gizmoAxis for move-drag hit testing
let gizmoRotateTargets = [];   // meshes tagged with userData.gizmoAxis for rotate-drag hit testing
let moveDragGizmo = null;      // { axisWorld, startPoint, startObjectPos }
let rotateDragGizmo = null;    // { axisWorld, centerScreen, prevAngle, accumAngle, startQuaternion }

function buildGizmo(record) {
  const size = axisGizmoLocalSize(record);
  const group = new THREE.Group();
  group.userData.isHelper = true; // never a "part" — explode/parts-of code must skip it
  const moveTargets = [];
  const rotateTargets = [];

  // --- move arrows ---
  const shaftLen = size * 0.9, shaftR = size * 0.035, headLen = size * 0.28, headR = size * 0.09;
  // Invisible, fully transparent — but still raycastable (mesh.visible must
  // stay true, only opacity goes to 0) — proxy material shared by every
  // fattened hit target below.
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false });
  const AXES = ['x', 'y', 'z'];
  for (const axis of AXES) {
    const mat = new THREE.MeshBasicMaterial({ color: AXIS_COLOR[axis], depthTest: false, transparent: true, opacity: 0.95 });
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 10), mat);
    shaft.position.y = shaftLen / 2;
    shaft.renderOrder = 999;
    const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 10), mat);
    head.position.y = shaftLen + headLen / 2;
    head.renderOrder = 999;
    arrow.add(shaft, head);
    if (axis === 'x') arrow.rotation.z = -Math.PI / 2;
    else if (axis === 'z') arrow.rotation.x = Math.PI / 2;
    shaft.userData.isHelper = true;
    head.userData.isHelper = true;

    // The painted shaft/head are too thin a target for a fingertip — a
    // touch that visually lands right on the arrow often misses the exact
    // geometry and falls through to "look around" instead, which is what
    // made dragging feel unreliable. Hit-testing goes against these much
    // fatter invisible proxies instead; the visible meshes stay slim.
    const shaftHit = new THREE.Mesh(new THREE.CylinderGeometry(shaftR * 3.5, shaftR * 3.5, shaftLen, 8), hitMat);
    shaftHit.position.y = shaftLen / 2;
    const headHit = new THREE.Mesh(new THREE.ConeGeometry(headR * 1.5, headLen * 1.3, 8), hitMat);
    headHit.position.y = shaftLen + headLen / 2;
    shaftHit.userData.gizmoAxis = axis;
    headHit.userData.gizmoAxis = axis;
    shaftHit.userData.isHelper = true;
    headHit.userData.isHelper = true;
    arrow.add(shaftHit, headHit);
    moveTargets.push(shaftHit, headHit);
    group.add(arrow);
  }

  // --- rotate rings ---
  const ringR = size * 0.85, tubeR = size * 0.03;
  for (const axis of AXES) {
    const mat = new THREE.MeshBasicMaterial({ color: AXIS_COLOR[axis], depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const torus = new THREE.Mesh(new THREE.TorusGeometry(ringR, tubeR, 8, 48), mat);
    torus.renderOrder = 998;
    if (axis === 'y') torus.rotateX(-Math.PI / 2);   // normal -> +Y (lies flat, spins around vertical)
    else if (axis === 'x') torus.rotateY(Math.PI / 2); // normal -> +X
    // z: default torus normal is already +Z
    torus.userData.isHelper = true;
    group.add(torus);

    // Same reasoning as the move arrows: a fatter invisible tube around the
    // painted ring so a finger doesn't have to land exactly on the thin
    // torus to grab it.
    const torusHit = new THREE.Mesh(new THREE.TorusGeometry(ringR, tubeR * 4, 8, 48), hitMat);
    torusHit.renderOrder = 998;
    torusHit.rotation.copy(torus.rotation);
    torusHit.userData.gizmoAxis = axis;
    torusHit.userData.isHelper = true;
    rotateTargets.push(torusHit);
    group.add(torusHit);
  }

  return { group, moveTargets, rotateTargets };
}

function removeGizmo() {
  if (!gizmo) return;
  gizmo.parent?.remove(gizmo);
  gizmo.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  gizmo = null;
  gizmoMoveTargets = [];
  gizmoRotateTargets = [];
  moveDragGizmo = null;
  rotateDragGizmo = null;
}

// Closest point on the infinite line (lineOrigin, lineDir) to the ray
// (rayOrigin, rayDir) — standard skew-line formula, used to drag an object
// smoothly along one world-space axis regardless of viewing angle.
function closestPointOnLineToRay(lineOrigin, lineDir, rayOrigin, rayDir) {
  const w0 = new THREE.Vector3().subVectors(lineOrigin, rayOrigin);
  const a = lineDir.dot(lineDir), b = lineDir.dot(rayDir), c = rayDir.dot(rayDir);
  const d = lineDir.dot(w0), e = rayDir.dot(w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-6) return lineOrigin.clone();
  const t = (b * e - c * d) / denom;
  return lineOrigin.clone().addScaledVector(lineDir, t);
}

// Projects a world point to renderer-canvas client pixels — the inverse of
// rayFromClient's NDC conversion, used to track the rotate gizmo in screen
// space (see beginRotateDrag below).
function projectToScreenPx(worldPoint) {
  const p = worldPoint.clone().project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  return { x: (p.x * 0.5 + 0.5) * rect.width + rect.left, y: (-p.y * 0.5 + 0.5) * rect.height + rect.top };
}

const LOCAL_AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function beginMoveDrag(axisLetter, ray) {
  const axisWorld = LOCAL_AXES[axisLetter].clone().transformDirection(selected.root.matrixWorld).normalize();
  const startPoint = closestPointOnLineToRay(selected.root.position, axisWorld, ray.ray.origin, ray.ray.direction);
  moveDragGizmo = { axisWorld, startPoint, startObjectPos: selected.root.position.clone() };
}

function updateMoveDrag(ray) {
  const newPoint = closestPointOnLineToRay(selected.root.position, moveDragGizmo.axisWorld, ray.ray.origin, ray.ray.direction);
  const delta = new THREE.Vector3().subVectors(newPoint, moveDragGizmo.startPoint);
  const pos = moveDragGizmo.startObjectPos.clone().add(delta);
  selected.root.position.set(roundMm(pos.x), roundMm(pos.y), roundMm(pos.z));
  outlineHelper?.update();
}

// Rotate-drag tracking is pure screen-space angle around the object's
// projected centre, not a 3D ray/plane intersection: a ray/plane hit makes
// the finger match one exact point in space, but a metre-scale ring then
// needs a proportionally huge sweep on screen to turn all the way round —
// that reads as sluggish. Screen-space angle stays comfortable regardless
// of the object's size or camera distance, and the multiplier below keeps
// it snappy rather than a 1:1 crawl.
const ROTATE_DRAG_SENSITIVITY = 1.8;

function beginRotateDrag(axisLetter, clientX, clientY) {
  const root = selected.root;
  const axisWorld = LOCAL_AXES[axisLetter].clone().transformDirection(root.matrixWorld).normalize();
  const centerScreen = projectToScreenPx(root.position);
  const startAngle = Math.atan2(clientY - centerScreen.y, clientX - centerScreen.x);
  rotateDragGizmo = { axisWorld, centerScreen, prevAngle: startAngle, accumAngle: 0, startQuaternion: root.quaternion.clone() };
  return true;
}

function updateRotateDrag(clientX, clientY) {
  const g = rotateDragGizmo;
  const angle = Math.atan2(clientY - g.centerScreen.y, clientX - g.centerScreen.x);
  let step = angle - g.prevAngle;
  // Shortest-path wrap so crossing the ±π seam behind the cursor doesn't
  // snap the object around instead of continuing the turn smoothly.
  if (step > Math.PI) step -= Math.PI * 2;
  if (step < -Math.PI) step += Math.PI * 2;
  g.prevAngle = angle;
  g.accumAngle += step * ROTATE_DRAG_SENSITIVITY;
  const deltaQuat = new THREE.Quaternion().setFromAxisAngle(g.axisWorld, g.accumAngle);
  selected.root.quaternion.multiplyQuaternions(deltaQuat, g.startQuaternion);
  outlineHelper?.update();
}

// ---------------------------------------------------------------------------
// Live-updated engineering-style dimension lines — an arrow-to-arrow line
// spanning the selected object's actual X/Y/Z extent (e.g. one side of a
// cylinder to the other for its diameter), with the mm value labelled
// alongside, drawn as SVG so real arrowheads are free. Uses the object's
// actual local bounding box (not an assumed centre) so it's correct even
// for a merged object whose geometry isn't centred at its own origin.
// ---------------------------------------------------------------------------
const dimGroups = {
  x: { g: document.getElementById('dimGroupX'), line: document.querySelector('#dimGroupX .dim-line'), text: document.querySelector('#dimGroupX .dim-text') },
  y: { g: document.getElementById('dimGroupY'), line: document.querySelector('#dimGroupY .dim-line'), text: document.querySelector('#dimGroupY .dim-text') },
  z: { g: document.getElementById('dimGroupZ'), line: document.querySelector('#dimGroupZ .dim-line'), text: document.querySelector('#dimGroupZ .dim-text') },
};

function hideDimensionOverlay() {
  for (const axis of ['x', 'y', 'z']) dimGroups[axis].g.classList.add('hidden');
}

function updateAxisLabels() {
  if (!selected || selected.kind === 'ground' || selected.kind === 'sketchLine' || mode !== 'edit') {
    hideDimensionOverlay();
    return;
  }
  const root = selected.root;
  let localMin, localMax, sizeMm;
  if (selected.kind === 'window') {
    const p = root.userData.windowParams;
    localMin = new THREE.Vector3(-p.width / 2, -p.height / 2, -p.thickness / 2);
    localMax = new THREE.Vector3(p.width / 2, p.height / 2, p.thickness / 2);
    sizeMm = new THREE.Vector3(p.width, p.height, p.thickness).multiply(root.scale);
  } else {
    const box = localBoundingBox(root);
    localMin = box.min;
    localMax = box.max;
    sizeMm = box.getSize(new THREE.Vector3()).multiply(root.scale);
  }
  const localCenter = localMin.clone().add(localMax).multiplyScalar(0.5);
  // one arrow-to-arrow span per axis, running edge-to-edge through the centre
  const ends = {
    x: [new THREE.Vector3(localMin.x, localCenter.y, localCenter.z), new THREE.Vector3(localMax.x, localCenter.y, localCenter.z)],
    y: [new THREE.Vector3(localCenter.x, localMin.y, localCenter.z), new THREE.Vector3(localCenter.x, localMax.y, localCenter.z)],
    z: [new THREE.Vector3(localCenter.x, localCenter.y, localMin.z), new THREE.Vector3(localCenter.x, localCenter.y, localMax.z)],
  };
  const texts = { x: `${formatMm(sizeMm.x)} мм`, y: `${formatMm(sizeMm.y)} мм`, z: `${formatMm(sizeMm.z)} мм` };

  const toScreen = (v) => {
    const ndc = v.clone().applyMatrix4(root.matrixWorld).project(camera);
    return { x: (ndc.x * 0.5 + 0.5) * window.innerWidth, y: (-ndc.y * 0.5 + 0.5) * window.innerHeight, behind: ndc.z < -1 || ndc.z > 1 };
  };

  // All three spans share the same centre point, so anchoring every label at
  // its own line's exact midpoint puts all three labels on top of each other
  // in screen space — that's the "solid clump of text" bug. Two independent
  // fixes, combined: anchor each label 2/3 of the way toward its own line's
  // end (not dead centre, so the three anchors land at genuinely different
  // screen points), and give each axis a different perpendicular offset
  // distance so even a coincidental viewing angle can't restack them.
  const LABEL_ANCHOR_T = 0.68;
  const LABEL_OFFSET_PX = { x: 14, y: 24, z: 34 };
  for (const axis of ['x', 'y', 'z']) {
    const [aLocal, bLocal] = ends[axis];
    const a = toScreen(aLocal), b = toScreen(bLocal);
    const { g, line, text } = dimGroups[axis];
    if (a.behind || b.behind || Math.hypot(a.x - b.x, a.y - b.y) < 6) { g.classList.add('hidden'); continue; }
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    const mx = a.x + (b.x - a.x) * LABEL_ANCHOR_T, my = a.y + (b.y - a.y) * LABEL_ANCHOR_T;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // perpendicular unit vector
    text.setAttribute('x', mx + nx * LABEL_OFFSET_PX[axis]);
    text.setAttribute('y', my + ny * LABEL_OFFSET_PX[axis]);
    text.textContent = texts[axis];
    g.classList.remove('hidden');
  }
}

// Diameter callout for every hole cut into the selected object (see
// performHolePlacement, which records each cut's local position/radius on
// selected.holes) — a small dot on the hole, a leader to a "⌀160 мм" label
// so it's readable without overlapping the hole itself. Rebuilt each frame
// like the dimension lines above; hole counts per object are always small,
// so recreating the DOM nodes is cheap enough to not bother pooling them.
const holeLabelsGroupEl = document.getElementById('holeLabelsGroup');
const SVG_NS = 'http://www.w3.org/2000/svg';

function updateHoleLabels() {
  if (!selected || !selected.holes || !selected.holes.length || mode !== 'edit') {
    if (holeLabelsGroupEl.childElementCount) holeLabelsGroupEl.innerHTML = '';
    return;
  }
  const root = selected.root;
  const frag = document.createDocumentFragment();
  for (const hole of selected.holes) {
    const ndc = hole.local.clone().applyMatrix4(root.matrixWorld).project(camera);
    if (ndc.z < -1 || ndc.z > 1) continue;
    const x = (ndc.x * 0.5 + 0.5) * window.innerWidth, y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
    const lx = x + 26, ly = y - 22; // label sits up-right of the hole

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'hole-label');

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'hole-dot');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 2.5);
    g.appendChild(dot);

    const leader = document.createElementNS(SVG_NS, 'line');
    leader.setAttribute('class', 'hole-leader');
    leader.setAttribute('x1', x); leader.setAttribute('y1', y);
    leader.setAttribute('x2', lx); leader.setAttribute('y2', ly);
    g.appendChild(leader);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'hole-text');
    text.setAttribute('x', lx + 4);
    text.setAttribute('y', ly);
    text.textContent = `⌀${formatMm(hole.radius * 2, 0)} мм`;
    g.appendChild(text);

    frag.appendChild(g);
  }
  holeLabelsGroupEl.innerHTML = '';
  holeLabelsGroupEl.appendChild(frag);
}

// Width/height callouts for every tile cut down from the standard size
// (tileRecord.tileCut, set in commitTileArea) — always on, not gated by
// selection, since the point is a cut size readable at a glance while
// laying tiles, not one you have to tap each piece to check. Reuses the
// same arrow-tipped/colour-coded look as the per-object dimension lines
// above (X = width, always red; the tile's other in-plane axis — Y on a
// wall, Z on a floor/ceiling — is the height).
const tileCutLabelsGroupEl = document.getElementById('tileCutLabelsGroup');

function appendTileDimLine(frag, root, localEnds, labelText, axis, offsetPx) {
  const toScreen = (v) => {
    const ndc = v.clone().applyMatrix4(root.matrixWorld).project(camera);
    return { x: (ndc.x * 0.5 + 0.5) * window.innerWidth, y: (-ndc.y * 0.5 + 0.5) * window.innerHeight, behind: ndc.z < -1 || ndc.z > 1 };
  };
  const a = toScreen(localEnds[0]), b = toScreen(localEnds[1]);
  if (a.behind || b.behind || Math.hypot(a.x - b.x, a.y - b.y) < 4) return;

  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', `dim-line dim-line-${axis}`);
  line.setAttribute('marker-start', `url(#dimArrow${axis.toUpperCase()})`);
  line.setAttribute('marker-end', `url(#dimArrow${axis.toUpperCase()})`);
  line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
  line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
  frag.appendChild(line);

  // Anchored 2/3 toward one end (not dead centre) with a perpendicular
  // offset, same fix as updateAxisLabels — the width and height lines
  // share the tile's centre point, so a centred label would clump them.
  const t = 0.68;
  const mx = a.x + (b.x - a.x) * t, my = a.y + (b.y - a.y) * t;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', `dim-text dim-text-${axis}`);
  text.setAttribute('x', mx + nx * offsetPx);
  text.setAttribute('y', my + ny * offsetPx);
  text.textContent = labelText;
  frag.appendChild(text);
}

function updateTileCutLabels() {
  const cutTiles = mode === 'edit' ? objects.filter((r) => r.kind === 'tile' && r.tileCut) : [];
  if (!cutTiles.length) {
    if (tileCutLabelsGroupEl.childElementCount) tileCutLabelsGroupEl.innerHTML = '';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const rec of cutTiles) {
    const { w, h, wallLike } = rec.tileCut;
    const hw = w / 2, hh = h / 2;
    const wEnds = [new THREE.Vector3(-hw, 0, 0), new THREE.Vector3(hw, 0, 0)];
    const hEnds = wallLike
      ? [new THREE.Vector3(0, -hh, 0), new THREE.Vector3(0, hh, 0)]
      : [new THREE.Vector3(0, 0, -hh), new THREE.Vector3(0, 0, hh)];
    appendTileDimLine(frag, rec.root, wEnds, `${formatMm(w, 0)} мм`, 'x', 14);
    appendTileDimLine(frag, rec.root, hEnds, `${formatMm(h, 0)} мм`, wallLike ? 'y' : 'z', 20);
  }
  tileCutLabelsGroupEl.innerHTML = '';
  tileCutLabelsGroupEl.appendChild(frag);
}

// The UNSCALED local size along one axis — needed to work out what scale
// factor turns "current geometry" into "the mm the user just typed in".
function getBaseAxisSizeMm(record, axis) {
  if (record.kind === 'window') {
    const p = record.root.userData.windowParams;
    return { x: p.width, y: p.height, z: p.thickness }[axis];
  }
  return localBoundingBox(record.root).getSize(new THREE.Vector3())[axis] || 1;
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
  record.root.traverse((o) => { if (o.isMesh && o.userData.role !== 'glass' && !o.userData.isHelper) meshes.push(o); });
  const m = meshes[0]?.material;
  return m?.userData?.creslarnetColor || DEFAULT_PAINT;
}

function applyColorToSelected(color) {
  if (!selected) return;
  selected.root.traverse((o) => {
    if (!o.isMesh || o.userData.role === 'glass' || o.userData.isHelper) return;
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
    if (!o.isMesh || o.userData.role === 'glass' || o.userData.isHelper) return;
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
    // Remembered in the object's own local space (not world) so the label
    // keeps tracking the right spot on the surface if the object is later
    // moved or rotated — see updateHoleLabels().
    selected.holes = selected.holes || [];
    selected.holes.push({ local: selected.root.worldToLocal(hit.point.clone()), radius: holeRadius });
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
// "Зігнути" — a single-mesh pipe/rebar/beam gets bent at a tapped point by
// a slider angle. Only single-mesh objects (kind pipe/rebar/beam whose
// root IS the mesh, not a Group) — a multi-segment run from "Просторова
// лінія" already has its own joints and isn't what this tool is for.
// The bend is a straight — circular arc — straight path built fresh from
// the object's ORIGINAL straight measurements every time the point or
// angle changes (never compounding onto an already-bent geometry), so the
// slider always represents "how bent from straight", not "how much more".
// ---------------------------------------------------------------------------
let bendActive = false;
let bendTarget = null;     // record being bent
let bendOriginal = null;   // { length, halfY, halfZ } measured once, from the straight geometry
let bendFrac = 0.5;        // 0..1 along the length
let bendAngleDeg = 0;
let bendPointSet = false;

class BentPathCurve extends THREE.Curve {
  constructor(L1, R, angleRad, L3) {
    super();
    this.L1 = L1; this.R = R; this.angleRad = angleRad; this.L3 = L3;
    this.arcLen = R * Math.abs(angleRad);
    this.total = Math.max(1, L1 + this.arcLen + L3);
  }
  getPoint(t, target = new THREE.Vector3()) {
    const s = Math.max(0, Math.min(1, t)) * this.total;
    const sign = this.angleRad >= 0 ? 1 : -1;
    if (s <= this.L1) {
      target.set(s, 0, 0);
    } else if (s <= this.L1 + this.arcLen) {
      const a = this.R > 0 ? (s - this.L1) / this.R : 0;
      target.set(this.L1 + this.R * Math.sin(a), sign * this.R * (1 - Math.cos(a)), 0);
    } else {
      const s3 = s - this.L1 - this.arcLen;
      const a = Math.abs(this.angleRad);
      const p1x = this.L1 + this.R * Math.sin(a), p1y = sign * this.R * (1 - Math.cos(a));
      target.set(p1x + s3 * Math.cos(this.angleRad), p1y + s3 * Math.sin(this.angleRad), 0);
    }
    return target;
  }
}

function measureBendable(record) {
  const root = record.root;
  root.geometry.computeBoundingBox();
  const size = root.geometry.boundingBox.getSize(new THREE.Vector3());
  return { length: size.x, halfY: size.y / 2, halfZ: size.z / 2 };
}

// Cross-section shape in the local YZ plane, matching each kind's own
// existing proportions (buildPipeGeometry's outer/inner ratio for pipe,
// a plain disc for rebar, a rectangle for beam).
function buildBendCrossSection(kind, halfY, halfZ) {
  if (kind === 'pipe') {
    const outerR = (halfY + halfZ) / 2;
    const shape = new THREE.Shape();
    shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, outerR * (55 / 70), 0, Math.PI * 2, true); // same wall-thickness ratio as buildPipeGeometry's defaults
    shape.holes.push(hole);
    return shape;
  }
  if (kind === 'rebar') {
    const r = (halfY + halfZ) / 2;
    const shape = new THREE.Shape();
    shape.absarc(0, 0, r, 0, Math.PI * 2, false);
    return shape;
  }
  const shape = new THREE.Shape(); // beam
  shape.moveTo(-halfY, -halfZ);
  shape.lineTo(halfY, -halfZ);
  shape.lineTo(halfY, halfZ);
  shape.lineTo(-halfY, halfZ);
  shape.closePath();
  return shape;
}

function buildStraightBendGeometry(kind, orig) {
  const shape = buildBendCrossSection(kind, orig.halfY, orig.halfZ);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: orig.length, bevelEnabled: false, curveSegments: 24 });
  geometry.rotateY(-Math.PI / 2); // same remap buildPipeGeometry uses: default +Z depth -> local +X
  geometry.translate(orig.length / 2, 0, 0);
  return geometry;
}

function applyBend(record, frac, angleDeg) {
  const orig = record.bendOriginal || bendOriginal;
  if (!orig) return;
  const angleRad = (angleDeg * Math.PI) / 180;
  const crossSize = Math.max(orig.halfY, orig.halfZ, 5);
  const R = Math.max(crossSize * 4, 40); // arc radius scaled to the cross-section, so it reads as a smooth bend, not a sharp kink
  const L1 = Math.max(0, orig.length * frac);
  const L3 = Math.max(0, orig.length * (1 - frac));

  try {
    const geometry = Math.abs(angleDeg) < 0.5
      ? buildStraightBendGeometry(record.kind, orig)
      : new THREE.ExtrudeGeometry(buildBendCrossSection(record.kind, orig.halfY, orig.halfZ), {
          steps: 48, extrudePath: new BentPathCurve(L1, R, angleRad, L3), bevelEnabled: false,
        });
    geometry.computeBoundingBox();
    const c = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-c.x, -c.y, -c.z);
    record.root.geometry.dispose();
    record.root.geometry = geometry;
    if (selected === record) outlineHelper?.update();
  } catch (e) {
    toast('Не вдалося застосувати згин тут — спробуйте інший кут або точку');
  }
}

function setBendPointFromTap(clientX, clientY) {
  if (!bendTarget) return;
  const hits = rayFromClient(clientX, clientY).intersectObject(bendTarget.root, true);
  if (!hits.length) { toast('Торкніться самого об’єкта'); return; }
  const local = bendTarget.root.worldToLocal(hits[0].point.clone());
  bendFrac = Math.max(0.05, Math.min(0.95, (local.x + bendOriginal.length / 2) / bendOriginal.length));
  bendPointSet = true;
  applyBend(bendTarget, bendFrac, bendAngleDeg);
  renderBendPill();
}

function enterBendMode(record) {
  bendActive = true;
  bendTarget = record;
  bendOriginal = measureBendable(record);
  bendFrac = 0.5;
  bendAngleDeg = 0;
  bendPointSet = false;
  // Stays selected (same pattern as the hole tool) so the selection panel
  // can be refreshed with the bend's new size on exit — but the move/
  // rotate gizmo's arrows are hidden for now: they'd sit right on top of
  // the very object the user needs to tap along its length to place the
  // bend point, and would otherwise steal that tap first.
  hideEl(selectionPanelEl);
  removeGizmo();
  renderBendPill();
  showEl(modePillEl);
  toast('Торкніться об’єкта, щоб позначити точку згину, тоді тягніть повзунок кута');
}

function exitBendMode(keep) {
  if (!keep && bendTarget && bendOriginal) applyBend(bendTarget, 0.5, 0); // revert to straight
  const record = bendTarget;
  bendActive = false;
  bendTarget = null;
  bendOriginal = null;
  hideEl(modePillEl);
  // Rebuild the gizmo removeGizmo() took down, and refresh the panel with
  // the bend's actual new dimensions — select() no-ops if already
  // selected, so deselect first.
  if (record) { deselect(); select(record); }
}

function renderBendPill() {
  modePillEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = bendPointSet ? `Точка згину: ${Math.round(bendFrac * 100)}%` : 'Торкніться об’єкта — точка згину';
  modePillEl.appendChild(label);

  const angleInput = document.createElement('input');
  angleInput.type = 'range'; angleInput.min = '-120'; angleInput.max = '120'; angleInput.step = '1';
  angleInput.value = String(bendAngleDeg);
  angleInput.className = 'bend-angle-slider';
  const angleLabel = document.createElement('span');
  angleLabel.className = 'bend-angle-label';
  angleLabel.textContent = `${bendAngleDeg}°`;
  angleInput.addEventListener('input', () => {
    bendAngleDeg = Number(angleInput.value);
    angleLabel.textContent = `${bendAngleDeg}°`;
    if (bendPointSet) applyBend(bendTarget, bendFrac, bendAngleDeg);
  });
  modePillEl.appendChild(angleInput);
  modePillEl.appendChild(angleLabel);

  const doneBtn = document.createElement('button');
  doneBtn.textContent = '✓ Готово';
  doneBtn.addEventListener('click', () => exitBendMode(true));
  modePillEl.appendChild(doneBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ Скасувати';
  cancelBtn.addEventListener('click', () => exitBendMode(false));
  modePillEl.appendChild(cancelBtn);
}

// ---------------------------------------------------------------------------
// "Різьба" — a helical ridge (a thin tube wound in a spiral, the standard
// cheap-but-honest way to fake a screw thread visually without an actual
// boolean cut) added near one end of a pipe/rebar, from a pitch and a
// length. Added as a child mesh of the object's own root rather than
// merged into its geometry — moves/scales/recolours with the parent for
// free, at the cost of not round-tripping through project save/load
// (serializeObjectRecord only captures the root mesh's own geometry) —
// a real but acceptable limitation, same category as a few other things
// this session (a bent object's exact curve isn't re-editable either).
// ---------------------------------------------------------------------------
class HelixCurve extends THREE.Curve {
  constructor(radius, pitch, length, startX, direction) {
    super();
    this.radius = radius;
    this.length = length;
    this.startX = startX;
    this.direction = direction; // +1 or -1 — which way along local X the thread runs from startX
    this.turns = Math.max(1, length / Math.max(0.5, pitch));
  }
  getPoint(t, target = new THREE.Vector3()) {
    const angle = t * this.turns * Math.PI * 2;
    target.set(this.startX + this.direction * t * this.length, this.radius * Math.cos(angle), this.radius * Math.sin(angle));
    return target;
  }
}

function addThreadToObject(record, atStart, pitch, length) {
  if (!record.root.isMesh) return;
  const orig = measureBendable(record); // same bounding-box measurement the bend tool uses
  const outerR = Math.max(orig.halfY, orig.halfZ, 3);
  const halfLen = orig.length / 2;
  const clampedLen = Math.max(2, Math.min(length, orig.length * 0.9));
  const startX = atStart ? -halfLen : halfLen;
  const direction = atStart ? 1 : -1; // always grows inward from the chosen end

  try {
    const curve = new HelixCurve(outerR, pitch, clampedLen, startX, direction);
    const tubeR = Math.max(0.6, pitch * 0.22);
    const tubularSegments = Math.max(24, Math.round(curve.turns * 14));
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, tubeR, 6, false);
    const mesh = new THREE.Mesh(geometry, createPaintMaterial('#9a9a9a'));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    record.root.add(mesh);
  } catch (e) {
    toast('Не вдалося додати різьбу тут — спробуйте інший крок або довжину');
  }
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

  if (selected.roomId) {
    selectionPanelEl.appendChild(buildRoomDimsSection(selected.roomId));
  }

  if (selected.kind === 'ground') {
    const hint = document.createElement('p');
    hint.className = 'dim-readout';
    hint.textContent = 'Поверхня землі — колір і матеріал (за бажанням, наприклад «Трава»).';
    selectionPanelEl.appendChild(hint);
    selectionPanelEl.appendChild(colorSwatchRow(currentPaintColor(selected), applyColorToSelected));
    selectionPanelEl.appendChild(materialSwatchRow(applyMaterialToSelected));
    return;
  }

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

  if (selected.kind === 'spatialLine') {
    const pts = selected.spatialLinePoints || [];
    let totalLen = 0;
    for (let i = 1; i < pts.length; i++) totalLen += pts[i - 1].distanceTo(pts[i]);
    const info = document.createElement('p');
    info.className = 'dim-readout';
    info.textContent = `Точок: ${pts.length}, довжина: ${formatMm(totalLen)} мм`;
    selectionPanelEl.appendChild(info);

    const hint = document.createElement('p');
    hint.className = 'dim-readout';
    hint.textContent = 'Перетворити на:';
    selectionPanelEl.appendChild(hint);

    const convertRow = document.createElement('div');
    convertRow.className = 'panel-row';
    for (const kind of ['pipe', 'rebar']) {
      const b = document.createElement('button');
      b.className = 'pbtn';
      b.textContent = `→ ${KIND_LABELS[kind]}`;
      b.addEventListener('click', () => convertSpatialLine(selected, kind));
      convertRow.appendChild(b);
    }
    selectionPanelEl.appendChild(convertRow);

    const wireHint = document.createElement('p');
    wireHint.className = 'dim-readout';
    wireHint.textContent = '→ Провід — оберіть колір:';
    selectionPanelEl.appendChild(wireHint);
    const wireRow = document.createElement('div');
    wireRow.className = 'panel-row';
    for (const w of WIRE_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = w.color;
      b.title = w.name;
      b.addEventListener('click', () => convertSpatialLine(selected, 'wire', w.color));
      wireRow.appendChild(b);
    }
    selectionPanelEl.appendChild(wireRow);

    const delBtn2 = document.createElement('button');
    delBtn2.className = 'pbtn danger wide';
    delBtn2.textContent = '🗑 Видалити лінію';
    delBtn2.addEventListener('click', () => removeObject(selected));
    selectionPanelEl.appendChild(delBtn2);
    return;
  }

  // A room part's length/height/rotation come from the room spec above —
  // its own generic size/rotation controls would just fight that on the
  // next resize, so only offer them for objects outside any room.
  if (!selected.roomId) {
    selectionPanelEl.appendChild(buildSizeSection(selected));
    selectionPanelEl.appendChild(buildRotationSection(selected));
  }

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

  if (selected.root.isMesh && ['pipe', 'rebar', 'beam'].includes(selected.kind)) {
    const bendBtn = document.createElement('button');
    bendBtn.className = 'pbtn'; bendBtn.textContent = '🦾 Зігнути';
    bendBtn.addEventListener('click', () => enterBendMode(selected));
    actions.appendChild(bendBtn);
  }

  if (selected.root.isMesh && ['pipe', 'rebar'].includes(selected.kind)) {
    const threadLabel = document.createElement('p');
    threadLabel.className = 'dim-readout';
    threadLabel.textContent = 'Різьба на кінці:';
    selectionPanelEl.appendChild(threadLabel);

    let threadAtStart = true, threadPitch = 2, threadLen = 20;

    const endRow = document.createElement('div'); endRow.className = 'panel-row';
    const startEndBtn = document.createElement('button'); startEndBtn.className = 'pbtn on'; startEndBtn.textContent = 'Початок';
    const endEndBtn = document.createElement('button'); endEndBtn.className = 'pbtn'; endEndBtn.textContent = 'Кінець';
    startEndBtn.addEventListener('click', () => { threadAtStart = true; startEndBtn.classList.add('on'); endEndBtn.classList.remove('on'); });
    endEndBtn.addEventListener('click', () => { threadAtStart = false; endEndBtn.classList.add('on'); startEndBtn.classList.remove('on'); });
    endRow.append(startEndBtn, endEndBtn);
    selectionPanelEl.appendChild(endRow);

    function stepperRow(labelText, get, set, step, min) {
      const row = document.createElement('div'); row.className = 'dim-row';
      const label = document.createElement('span'); label.className = 'dim-label'; label.textContent = labelText;
      const minus = document.createElement('button'); minus.className = 'dim-step'; minus.textContent = '–';
      const val = document.createElement('span'); val.className = 'dim-input'; val.style.textAlign = 'center';
      const plus = document.createElement('button'); plus.className = 'dim-step'; plus.textContent = '+';
      const refresh = () => { val.textContent = `${formatMm(get())} мм`; };
      refresh();
      minus.addEventListener('click', () => { set(Math.max(min, roundMm(get() - step))); refresh(); });
      plus.addEventListener('click', () => { set(roundMm(get() + step)); refresh(); });
      row.append(label, minus, val, plus);
      return row;
    }
    selectionPanelEl.appendChild(stepperRow('Крок різьби', () => threadPitch, (v) => { threadPitch = v; }, 0.5, 0.5));
    selectionPanelEl.appendChild(stepperRow('Довжина різьби', () => threadLen, (v) => { threadLen = v; }, 5, 5));

    const addThreadBtn = document.createElement('button');
    addThreadBtn.className = 'pbtn wide';
    addThreadBtn.textContent = '🔩 Додати різьбу';
    addThreadBtn.addEventListener('click', () => {
      addThreadToObject(selected, threadAtStart, threadPitch, threadLen);
      toast('Різьбу додано');
    });
    selectionPanelEl.appendChild(addThreadBtn);
  }

  if (canExplode(selected)) {
    const explodeBtn = document.createElement('button');
    explodeBtn.className = 'pbtn';
    explodeBtn.textContent = selected.exploded ? '🔧 Скласти назад' : '💥 Розібрати на частини';
    explodeBtn.addEventListener('click', () => toggleExplode(selected));
    actions.appendChild(explodeBtn);
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

    buildProjectLibrarySection();
  }

  if (panel === 'room') {
    const h = document.createElement('h3'); h.textContent = 'Кімната'; popoverEl.appendChild(h);
    const row = document.createElement('div'); row.className = 'panel-row';
    const newBtn = document.createElement('button');
    newBtn.className = 'pbtn wide';
    newBtn.textContent = '➕ Нова кімната';
    newBtn.addEventListener('click', () => {
      activeRoomId = createRoom();
      closePopover();
    });
    row.appendChild(newBtn);
    popoverEl.appendChild(row);

    if (activeRoomId && findRoomParts(activeRoomId).length) {
      const viewRow = document.createElement('div'); viewRow.className = 'panel-row';
      const insideBtn = document.createElement('button');
      insideBtn.className = 'pbtn';
      insideBtn.textContent = '🚪 Всередині';
      insideBtn.addEventListener('click', () => { viewRoomInside(activeRoomId); closePopover(); });
      const outsideBtn = document.createElement('button');
      outsideBtn.className = 'pbtn';
      outsideBtn.textContent = '🏠 Зовні';
      outsideBtn.addEventListener('click', () => { viewRoomOutside(activeRoomId); closePopover(); });
      viewRow.appendChild(insideBtn);
      viewRow.appendChild(outsideBtn);
      popoverEl.appendChild(viewRow);
      popoverEl.appendChild(buildRoomDimsSection(activeRoomId));
    } else {
      const hint = document.createElement('p');
      hint.className = 'dim-readout';
      hint.textContent = 'Створіть кімнату, щоб задати її розміри — ширину, довжину й висоту в міліметрах.';
      popoverEl.appendChild(hint);
    }
  }

  if (panel === 'tile3d') {
    const h = document.createElement('h3'); h.textContent = 'Плитка'; popoverEl.appendChild(h);

    const hint = document.createElement('p');
    hint.className = 'dim-readout';
    hint.textContent = 'Задайте розмір, кольори — тоді розтягніть прямокутну ділянку на стіні чи підлозі й натисніть «Покласти плитку»: викладе цілі плитки й акуратно обріже краї.';
    popoverEl.appendChild(hint);

    const sizeRow = document.createElement('div'); sizeRow.className = 'panel-row';
    for (const dim of [{ key: 'w', label: 'Ширина' }, { key: 'h', label: 'Висота' }]) {
      const label = document.createElement('span');
      label.className = 'axis-label';
      label.textContent = dim.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.className = 'size-input';
      input.value = formatMm(tileConfig[dim.key]);
      input.addEventListener('change', () => {
        const v = parseFloat(input.value.replace(',', '.'));
        if (Number.isFinite(v) && v > 10) tileConfig[dim.key] = roundMm(v);
        input.value = formatMm(tileConfig[dim.key]);
      });
      sizeRow.append(label, input);
    }
    popoverEl.appendChild(sizeRow);

    const colorLabel = document.createElement('p'); colorLabel.className = 'dim-readout'; colorLabel.textContent = 'Колір плитки';
    popoverEl.appendChild(colorLabel);
    popoverEl.appendChild(colorSwatchRow(tileConfig.color, (c) => { tileConfig.color = c; }));

    const groutLabel = document.createElement('p'); groutLabel.className = 'dim-readout'; groutLabel.textContent = 'Колір шва (фуги)';
    popoverEl.appendChild(groutLabel);
    popoverEl.appendChild(colorSwatchRow(tileConfig.groutColor, (c) => { tileConfig.groutColor = c; }));

    const groutRow = document.createElement('div'); groutRow.className = 'panel-row';
    const gLabel = document.createElement('span'); gLabel.className = 'axis-label'; gLabel.textContent = 'Шов';
    const gMinus = document.createElement('button'); gMinus.type = 'button'; gMinus.className = 'stepper-btn'; gMinus.textContent = '–';
    const gVal = document.createElement('span'); gVal.className = 'size-input'; gVal.style.textAlign = 'center'; gVal.textContent = `${formatMm(tileConfig.grout)} мм`;
    const gPlus = document.createElement('button'); gPlus.type = 'button'; gPlus.className = 'stepper-btn'; gPlus.textContent = '+';
    gMinus.addEventListener('click', () => { tileConfig.grout = Math.max(0, roundMm(tileConfig.grout - 0.5)); gVal.textContent = `${formatMm(tileConfig.grout)} мм`; });
    gPlus.addEventListener('click', () => { tileConfig.grout = roundMm(tileConfig.grout + 0.5); gVal.textContent = `${formatMm(tileConfig.grout)} мм`; });
    groutRow.append(gLabel, gMinus, gVal, gPlus);
    popoverEl.appendChild(groutRow);

    const toggleRow = document.createElement('div'); toggleRow.className = 'panel-row';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'pbtn wide' + (tileToolActive ? ' on' : '');
    toggleBtn.textContent = tileToolActive ? '■ Вимкнути інструмент' : '✓ Активувати — розтягніть ділянку на стіні/підлозі';
    toggleBtn.addEventListener('click', () => {
      tileToolActive = !tileToolActive;
      deselect();
      closePopover();
      if (tileToolActive) {
        cancelTileArea();
        showEl(modePillEl);
        renderTilePill();
        toast('Розтягніть прямокутну ділянку на стіні або підлозі, потім натисніть «Покласти плитку»');
      } else {
        cancelTileArea();
        hideEl(modePillEl);
      }
    });
    toggleRow.appendChild(toggleBtn);
    popoverEl.appendChild(toggleRow);
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

    const hLand = document.createElement('h3'); hLand.textContent = 'Сцена'; popoverEl.appendChild(hLand);
    const landRow = document.createElement('div'); landRow.className = 'panel-row';
    const landBtn = document.createElement('button');
    landBtn.className = 'pbtn wide' + (landscapeMode ? ' on' : '');
    landBtn.textContent = landscapeMode ? '⬛ AutoCAD-тема' : '☀ Ландшафт (небо + земля)';
    landBtn.addEventListener('click', () => { setLandscapeMode(!landscapeMode); closePopover(); });
    landRow.appendChild(landBtn);
    popoverEl.appendChild(landRow);

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

// ---------------------------------------------------------------------------
// Project library — whole scenes saved into this phone's browser storage
// and picked from a list, instead of a file dialog every time. Same
// localStorage pattern as "Мої об'єкти" above, but for a full project
// (buildProjectData/loadProject, the same pair "Файл" → Зберегти/
// Завантажити у файл uses) rather than one reusable object. Complements
// the file-based save/load — that one still round-trips to a real file you
// can move between devices; this is for quickly switching between a
// handful of projects kept on this one phone.
// ---------------------------------------------------------------------------
const PROJECT_LIBRARY_KEY = 'creslarnet-3d-project-library';

function loadProjectLibrary() {
  try {
    const raw = localStorage.getItem(PROJECT_LIBRARY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveProjectLibrary(entries) {
  try {
    localStorage.setItem(PROJECT_LIBRARY_KEY, JSON.stringify(entries));
    return true;
  } catch (e) {
    toast('Не вдалося зберегти — забракло місця. Видаліть якийсь збережений проєкт');
    return false;
  }
}

function buildProjectLibrarySection() {
  const h2 = document.createElement('h3'); h2.textContent = 'Збережені проєкти'; popoverEl.appendChild(h2);

  const saveRow = document.createElement('div'); saveRow.className = 'panel-row';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'pbtn wide';
  saveBtn.textContent = '💾 Зберегти поточний проєкт…';
  saveBtn.addEventListener('click', () => {
    const name = window.prompt('Назва проєкту:', `Проєкт ${new Date().toLocaleDateString('uk-UA')}`);
    if (!name || !name.trim()) return;
    const entries = loadProjectLibrary();
    entries.push({ id: `p_${Date.now().toString(36)}`, name: name.trim(), savedAt: Date.now(), data: buildProjectData() });
    if (saveProjectLibrary(entries)) {
      toast(`Проєкт «${name.trim()}» збережено`);
      popoverEl.innerHTML = '';
      buildPopoverContent('objects');
    }
  });
  saveRow.appendChild(saveBtn);
  popoverEl.appendChild(saveRow);

  const library = loadProjectLibrary();
  if (!library.length) {
    const empty = document.createElement('p');
    empty.className = 'dim-readout';
    empty.textContent = 'Поки порожньо — збережіть поточний проєкт кнопкою вище, щоб потім швидко повертатись до нього.';
    popoverEl.appendChild(empty);
    return;
  }
  for (const entry of [...library].reverse()) {
    const row = document.createElement('div');
    row.className = 'panel-row library-row';
    const loadBtn = document.createElement('button');
    loadBtn.className = 'pbtn';
    const when = new Date(entry.savedAt || 0).toLocaleDateString('uk-UA');
    loadBtn.textContent = `${entry.name} · ${when}`;
    loadBtn.addEventListener('click', () => {
      loadProject(entry.data);
      closePopover();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'pbtn danger';
    delBtn.textContent = '🗑';
    delBtn.title = 'Видалити зі збережених проєктів';
    delBtn.addEventListener('click', () => {
      saveProjectLibrary(loadProjectLibrary().filter((e) => e.id !== entry.id));
      popoverEl.innerHTML = '';
      buildPopoverContent('objects');
    });
    row.append(loadBtn, delBtn);
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
  camera.position.addScaledVector(dir, -e.deltaY * refDist * 0.0011);
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

    // A gizmo just attached this frame (or one that hasn't been touched
    // since) can still have a stale/identity matrixWorld if no render has
    // run yet — force it current before raycasting, same as the paper-draw
    // hit-test below does. Without this, a click that visually lands right
    // on a ring can silently miss it and fall through to "look around".
    if (mode === 'edit' && selected && gizmo) scene.updateMatrixWorld(true);
    const gizmoHit = mode === 'edit' && selected && gizmo
      ? rayFromClient(e.clientX, e.clientY).intersectObjects(gizmoMoveTargets.concat(gizmoRotateTargets), false)
      : [];
    if (gizmoHit.length) {
      const hitMesh = gizmoHit[0].object;
      const axisLetter = hitMesh.userData.gizmoAxis;
      if (gizmoMoveTargets.includes(hitMesh)) {
        beginMoveDrag(axisLetter, rayFromClient(e.clientX, e.clientY));
      } else {
        beginRotateDrag(axisLetter, e.clientX, e.clientY);
      }
    } else if (mode === 'edit' && moveMode && selected) {
      moveDragging = true;
    } else if (mode === 'edit' && paperDrawing && selected) {
      scene.updateMatrixWorld(true);
      const hits = rayFromClient(e.clientX, e.clientY).intersectObject(selected.root, false);
      if (hits.length) {
        drawStartWorld = hits[0].point.clone();
        paperDrawDragging = true;
      }
    } else if (mode === 'edit' && tileToolActive) {
      scene.updateMatrixWorld(true);
      const targets = objects.filter((r) => r.kind === 'wall' || r.kind === 'roomFloor' || r.kind === 'roomCeiling').map((r) => r.root);
      const hits = rayFromClient(e.clientX, e.clientY).intersectObjects(targets, false);
      if (hits.length) {
        const rec = findRecordByMesh(hits[0].object);
        if (rec) beginTileAreaDrag(rec, hits[0].point);
      }
    } else if (mode === 'edit' && spatialLineActive) {
      scene.updateMatrixWorld(true);
      if (spatialLineGizmo) {
        const hits = rayFromClient(e.clientX, e.clientY).intersectObjects(spatialLineGizmoTargets, false);
        if (hits.length) {
          const hitMesh = hits[0].object;
          if (hitMesh.userData.slRing) beginSpatialLineRingDrag(e.clientX, e.clientY);
          else beginSpatialLineDrag(hitMesh.userData.slAxis, rayFromClient(e.clientX, e.clientY));
        }
      } else {
        // First point: land it on whatever's under the tap, or 1.5 m out in
        // front of the camera if nothing's there — there's no paper/ground
        // plane requirement here, unlike the wall tool.
        const hits = rayFromClient(e.clientX, e.clientY).intersectObjects(raycastTargets, false);
        let point;
        if (hits.length) {
          point = hits[0].point.clone();
        } else {
          const dir = new THREE.Vector3();
          camera.getWorldDirection(dir);
          point = camera.position.clone().addScaledVector(dir, 1500);
        }
        spatialLineDraft = { points: [roundVec(point)] };
        attachSpatialLineGizmo(point);
        renderSpatialLinePill();
      }
    } else if (!moveMode && !paperDrawing) {
      lookPointerId = e.pointerId;
      lastLookX = e.clientX; lastLookY = e.clientY;
    }
  } else if (activePointers.size === 2 && !moveMode && !paperDrawing && !tileDrag && !spatialLineDrag && !spatialLineRingDrag) {
    pinchStartDist = currentPinchDist();
    // with something selected, pinch resizes it; otherwise it drives the camera
    pinchStartScale = selected ? selected.root.scale.clone() : null;
    lookPointerId = null; // second finger arrived — hand off from look to pinch
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (moveDragGizmo && e.pointerId === primaryPointerId) {
    updateMoveDrag(rayFromClient(e.clientX, e.clientY));
    return;
  }
  if (rotateDragGizmo && e.pointerId === primaryPointerId) {
    updateRotateDrag(e.clientX, e.clientY);
    return;
  }
  if (activePointers.size === 2 && !moveMode && !paperDrawing && !tileDrag && !spatialLineDrag && !spatialLineRingDrag) {
    const dist = currentPinchDist();
    if (selected && pinchStartScale) {
      if (pinchStartDist > 10) {
        const ratio = Math.max(0.05, dist / pinchStartDist);
        selected.root.scale.copy(pinchStartScale).multiplyScalar(ratio);
        outlineHelper?.update();
        refreshSizeInputs();
      }
    } else if (!selected && pinchStartDist > 0 && mode === 'edit' && isCameraInsideAnyRoom()) {
      // Inside a room, two-finger pinch is an optical zoom (camera.fov)
      // instead of moving the camera: a small room only has a metre or two
      // of actual floor space to dolly back into, nowhere near enough to
      // fit a whole wall (floor to ceiling) in view — widening the FOV
      // does, without needing to move at all. Spread apart = zoom in
      // (narrower FOV), pinch together = zoom out and see more, same
      // direction as pinch-zoom everywhere else.
      const delta = dist - pinchStartDist;
      setFov(camera.fov - delta * 0.15);
      pinchStartDist = dist;
    } else if (!selected && pinchStartDist > 0) {
      // navigation pinch (outside any room): spreading fingers apart moves
      // forward, pinching together moves back — tracked incrementally so
      // continuing the gesture keeps moving rather than saturating at one
      // ratio
      const delta = dist - pinchStartDist;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const refDist = forwardHitDistance();
      camera.position.addScaledVector(dir, delta * refDist * 0.0018);
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
  if (mode === 'edit' && tileDrag && e.pointerId === primaryPointerId) {
    const hits = rayFromClient(e.clientX, e.clientY).intersectObjects([tileDrag.record.root], false);
    if (hits.length) updateTileAreaDrag(hits[0].point);
    return;
  }
  if (mode === 'edit' && spatialLineDrag && e.pointerId === primaryPointerId) {
    updateSpatialLineDrag(rayFromClient(e.clientX, e.clientY));
    return;
  }
  if (mode === 'edit' && spatialLineRingDrag && e.pointerId === primaryPointerId) {
    updateSpatialLineRingDrag(e.clientX, e.clientY);
    return;
  }
  if (lookPointerId !== null && e.pointerId === lookPointerId) {
    handleFreeLook(e);
  }
});

function endPointer(e) {
  const wasPinching = activePointers.size >= 2 && pinchStartDist > 0;
  const wasGizmoDrag = !!(moveDragGizmo || rotateDragGizmo);
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) { pinchStartScale = null; pinchStartDist = 0; }
  if (lookPointerId === e.pointerId) lookPointerId = null;
  if (e.pointerId === primaryPointerId) { moveDragGizmo = null; rotateDragGizmo = null; }

  if (e.type === 'pointercancel') {
    if (mode === 'edit' && moveMode) moveDragging = false;
    if (mode === 'edit' && paperDrawing) { paperDrawDragging = false; drawStartWorld = null; clearPreviewLine(); }
    if (mode === 'edit' && tileToolActive) { tileDrag = null; clearTileAreaPreview(); renderTilePill(); }
    if (mode === 'edit' && spatialLineActive) {
      spatialLineDrag = null; spatialLineRingDrag = null;
      hideSpatialLineLengthLabel();
      updateSpatialLinePreview();
      if (spatialLineGizmo) renderSpatialLinePill();
    }
    return;
  }

  if (wasGizmoDrag) return; // a gizmo drag is never a tap
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
  if (mode === 'edit' && tileToolActive) {
    if (tileDrag && e.pointerId === primaryPointerId) {
      const hits = rayFromClient(e.clientX, e.clientY).intersectObjects([tileDrag.record.root], false);
      if (hits.length) {
        endTileAreaDrag(hits[0].point);
      } else {
        // released off the wall/floor — cancel this attempt rather than guess
        tileDrag = null;
        clearTileAreaPreview();
        renderTilePill();
      }
    }
    return;
  }
  if (mode === 'edit' && spatialLineActive) {
    if (spatialLineDrag && e.pointerId === primaryPointerId) endSpatialLineDrag();
    if (spatialLineRingDrag && e.pointerId === primaryPointerId) spatialLineRingDrag = null;
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
    const hits = ray.intersectObjects(raycastTargets, false);
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
    const hits = ray.intersectObjects(raycastTargets, false);
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
  if (bendActive) { setBendPointFromTap(x, y); return; }
  // tileToolActive is handled entirely as a drag in pointerdown/move/up
  // (see beginTileAreaDrag etc.) — a tap that isn't a drag just falls
  // through to normal selection below, same as with nothing active.

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

// Zoom buttons — a step per tap, and holding one repeats it, so it feels
// like a normal continuous zoom rather than a one-shot nudge.
function wireZoomButton(btn, stepSign) {
  let repeatTimer = null;
  // Straight dolly along the camera's own forward vector (the same vector
  // camera.getWorldDirection always returns, pitch included) — a pure
  // translation along that one direction has no sideways component by
  // construction, so it always moves exactly toward/away from wherever the
  // camera is currently looking, never off to one side. Scaled by what's
  // actually ahead (forwardHitDistance), same as the wheel/pinch dolly, so
  // a press feels equally fine near a wall and brisk out in the open.
  const step = () => {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const refDist = forwardHitDistance();
    camera.position.addScaledVector(dir, stepSign * refDist * 0.1);
  };
  const start = (e) => {
    e.preventDefault();
    step();
    clearInterval(repeatTimer);
    repeatTimer = setInterval(step, 140);
  };
  const stop = () => clearInterval(repeatTimer);
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
}
wireZoomButton(document.getElementById('zoomInBtn'), 1);   // dolly forward — closer
wireZoomButton(document.getElementById('zoomOutBtn'), -1); // dolly backward — see more (e.g. a whole nearby wall)

// "Просторова лінія" gets its own corner button (not buried in the
// scrollable bottom toolbar) — one tap starts it, tap again to cancel.
const spatialLineFabBtn = document.getElementById('spatialLineFab');
spatialLineFabBtn.addEventListener('click', () => {
  if (spatialLineActive) {
    cancelSpatialLine();
    spatialLineFabBtn.classList.remove('on');
    return;
  }
  spatialLineActive = true;
  deselect();
  spatialLineFabBtn.classList.add('on');
  renderSpatialLinePill();
  toast('Торкніться, щоб поставити першу точку лінії');
});

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
  const sens = 0.002;
  yaw -= dx * sens; // unclamped — a full 360° turn, like turning your head/body
  pitch -= dy * sens;
  // Just short of straight up/down (±90°) rather than exactly there — a
  // dead-on vertical look direction makes yaw ill-defined (gimbal-lock-ish
  // jitter), same reason most first-person cameras stop just shy of it.
  pitch = Math.max(-1.55, Math.min(1.55, pitch));
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
    speed = Math.max(90, Math.min(11000, refDist * 0.8));
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
  if (rec.spatialLinePoints) {
    // A "Просторова лінія" run (raw draft, or a converted pipe/wire/rebar)
    // is a Group of per-segment meshes, not one mesh with its own
    // .geometry/.material like the generic fallback below assumes — saved
    // as its points + target kind/colour instead, and rebuilt with
    // buildSpatialLineRunGroup on load, same as converting fresh.
    return {
      id: rec.id, kind: rec.kind,
      spatialLinePoints: rec.spatialLinePoints.map((p) => p.toArray()),
      runLabel: rec.runLabel, runColor: rec.runColor,
      position: (positionOverride || rec.root.position).toArray(),
      quaternion: rec.root.quaternion.toArray(),
      scale: rec.root.scale.toArray(),
    };
  }
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
  if (rec.kind === 'compound') {
    // Always save the COLLAPSED layout — a reloaded project starts intact,
    // never mid-explosion — regardless of whether it's exploded right now.
    const parts = partsOf(rec).map((child) => {
      const pos = rec.explodeOriginal?.get(child) || child.position;
      return {
        geometry: child.geometry.toJSON(),
        material: { type: child.material.userData.creslarnetType, color: child.material.userData.creslarnetColor },
        position: pos.toArray(),
        quaternion: child.quaternion.toArray(),
        scale: child.scale.toArray(),
      };
    });
    return {
      id: rec.id, kind: 'compound',
      position: (positionOverride || rec.root.position).toArray(),
      quaternion: rec.root.quaternion.toArray(),
      scale: rec.root.scale.toArray(),
      parts,
    };
  }
  const mesh = rec.root;
  return {
    id: rec.id, kind: rec.kind, isPipe: !!rec.isPipe, wallLength: rec.wallLength,
    paperId: rec.paperId, lineLength: rec.lineLength,
    lineStart: rec.lineStart?.toArray(), lineEnd: rec.lineEnd?.toArray(),
    roomId: rec.roomId, roomParams: rec.roomParams, roomCenter: rec.roomCenter,
    geometry: mesh.geometry.toJSON(),
    material: { type: mesh.material.userData.creslarnetType, color: mesh.material.userData.creslarnetColor },
    position: (positionOverride || mesh.position).toArray(),
    quaternion: mesh.quaternion.toArray(),
    scale: mesh.scale.toArray(),
  };
}

function buildProjectData() {
  return {
    app: 'creslarnet-3d', version: 2, units: 'mm',
    ground: { type: ground.material.userData.creslarnetType, color: ground.material.userData.creslarnetColor },
    objects: objects.map((rec) => serializeObjectRecord(rec)),
  };
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
  if (data.ground) {
    const newMat = data.ground.type === 'paint'
      ? createPaintMaterial(data.ground.color)
      : createMaterial(data.ground.type, data.ground.color, scene.environment);
    ground.material.dispose();
    ground.material = newMat;
    if (selected === groundRecord) renderSelectionPanel();
  }
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
  if (item.spatialLinePoints) {
    const points = item.spatialLinePoints.map((a) => new THREE.Vector3().fromArray(a));
    const { group } = buildSpatialLineRunGroup(points, item.kind, item.runColor);
    group.quaternion.fromArray(item.quaternion);
    if (item.scale) group.scale.fromArray(item.scale);
    return { root: group, extra: { spatialLinePoints: points, runLabel: item.runLabel, runColor: item.runColor } };
  }
  if (item.kind === 'window') {
    const group = buildWindowGroup(item.width, item.height, item.thickness, item.frameColor);
    group.quaternion.fromArray(item.quaternion);
    if (item.scale) group.scale.fromArray(item.scale);
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { root: group, extra: {} };
  }
  if (item.kind === 'compound') {
    const group = new THREE.Group();
    for (const p of item.parts) {
      const geometry = parseGeometryJSON(p.geometry);
      const material = p.material.type === 'paint'
        ? createPaintMaterial(p.material.color)
        : createMaterial(p.material.type, p.material.color, scene.environment);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.fromArray(p.position);
      mesh.quaternion.fromArray(p.quaternion);
      if (p.scale) mesh.scale.fromArray(p.scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    group.quaternion.fromArray(item.quaternion);
    if (item.scale) group.scale.fromArray(item.scale);
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
      roomId: item.roomId, roomParams: item.roomParams, roomCenter: item.roomCenter,
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
  if (!rec || rec.kind === 'ground') return;
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

  const compoundBtn = document.createElement('button');
  compoundBtn.textContent = '🧩 Групувати в об’єкт';
  compoundBtn.addEventListener('click', () => {
    if (groupSelection.size < 2) { toast('Оберіть щонайменше 2 об’єкти для групування'); return; }
    groupSelectionIntoCompound([...groupSelection]);
    exitGroupSelectMode();
  });
  modePillEl.appendChild(compoundBtn);

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

// Pulls a record's mesh(es) out of objects[]/raycastTargets WITHOUT
// disposing anything — used when reparenting a whole object into a new
// compound group, as opposed to removeObject() which deletes for good.
function detachFromRegistry(rec) {
  rec.root.traverse((o) => {
    if (o.isMesh) {
      const idx = raycastTargets.indexOf(o);
      if (idx !== -1) raycastTargets.splice(idx, 1);
    }
  });
  const idx = objects.indexOf(rec);
  if (idx !== -1) objects.splice(idx, 1);
  if (selected === rec) deselect();
}

// Bundles several independent objects into ONE selectable/movable object —
// e.g. build a shoe or a chair out of several primitives, then group them so
// they behave as a single thing (and can be exploded into their parts again,
// or saved to "Мої об’єкти" as one reusable item). Unlike merge, this keeps
// every part's own geometry/material/colour intact — nothing is fused.
function groupSelectionIntoCompound(records) {
  const groupable = records.filter((r) => r.root.isMesh);
  const skipped = records.length - groupable.length;
  if (groupable.length < 2) {
    toast('Групування працює для простих об’єктів (не вікон) — оберіть щонайменше 2');
    return;
  }

  const anchor = computeGroupAnchor(groupable);
  const group = new THREE.Group();
  group.position.copy(anchor);

  for (const rec of groupable) {
    detachFromRegistry(rec);
    scene.remove(rec.root);
    rec.root.position.sub(anchor); // world position preserved once reparented under `group`
    group.add(rec.root);
  }

  const record = registerObject('compound', group, {});
  select(record);
  toast(skipped
    ? `Згруповано ${groupable.length} об’єктів в один (вікна пропущено) — можна розібрати на частини`
    : `Згруповано ${groupable.length} об’єктів в один — можна розібрати на частини`);
}

// ---------------------------------------------------------------------------
// "Розібрати на частини" — for any object made of several parts (a window's
// frame+glass, or a compound assembly like a shoe/chair built from several
// primitives): nudge every part outward from the group's own centre so each
// one is visible on its own. Pressing again restores every part's exact
// original position — nothing is re-measured, just replayed from memory.
// ---------------------------------------------------------------------------
function partsOf(record) {
  return record.root.children.filter((c) => c.isMesh && !c.userData.isHelper);
}

function canExplode(record) {
  if (!record || record.kind === 'ground' || record.kind === 'sketchLine') return false;
  return partsOf(record).length > 1;
}

function toggleExplode(record) {
  const parts = partsOf(record);
  if (parts.length < 2) return;

  if (record.exploded) {
    for (const child of parts) {
      const orig = record.explodeOriginal?.get(child);
      if (orig) child.position.copy(orig);
    }
    record.exploded = false;
    record.explodeOriginal = null;
  } else {
    const originals = new Map();
    const centroid = new THREE.Vector3();
    for (const child of parts) { originals.set(child, child.position.clone()); centroid.add(child.position); }
    centroid.divideScalar(parts.length);

    const localSize = localBoundingBox(record.root).getSize(new THREE.Vector3());
    const spread = Math.max(localSize.x, localSize.y, localSize.z, 60) * EXPLODE_SPREAD_FACTOR;

    for (const child of parts) {
      const dir = new THREE.Vector3().subVectors(child.position, centroid);
      if (dir.lengthSq() < 1) {
        // a part sitting exactly at the centroid (rare) still needs to move
        // somewhere — nudge it upward so it doesn't stay hidden inside the rest
        dir.set(0, 1, 0);
      }
      dir.normalize();
      child.position.addScaledVector(dir, spread);
    }
    record.explodeOriginal = originals;
    record.exploded = true;
  }
  outlineHelper?.update();
  renderSelectionPanel();
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
// Orientation gizmo — small fixed corner widget (3ds Max / Blender style):
// three short colour-coded axes meeting at a compact hub, a ball tipping
// each one, X/Y/Z letters just past the tips. It's its own tiny scene +
// orthographic camera, rendered into a scissored corner of the same canvas
// right after the main scene each frame, with the gizmo camera mirroring
// the main camera's rotation — so it always reads "which way is which"
// without cluttering the model itself.
// ---------------------------------------------------------------------------
const axisGizmoScene = new THREE.Scene();
const axisGizmoCamera = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 10);
const AXIS_GIZMO_PX = 84;   // on-screen footprint, css px
const AXIS_GIZMO_MARGIN = 16;

function axisLabelSprite(letter, colorCss) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colorCss;
  ctx.font = '700 40px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, size / 2, size / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  sprite.scale.set(0.5, 0.5, 1);
  return sprite;
}

(function buildAxisGizmo() {
  const AXIS_DIR = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const AXIS_LETTER = { x: 'X', y: 'Y', z: 'Z' };
  const shaftLen = 0.8, shaftR = 0.05, ballR = 0.17;
  for (const axis of ['x', 'y', 'z']) {
    const dir = AXIS_DIR[axis];
    const colorCss = AXIS_COLOR_CSS[axis];
    const mat = new THREE.MeshBasicMaterial({ color: AXIS_COLOR[axis] });

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 12), mat);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    shaft.position.copy(dir).multiplyScalar(shaftLen / 2);
    axisGizmoScene.add(shaft);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 16, 12), mat);
    ball.position.copy(dir).multiplyScalar(shaftLen);
    axisGizmoScene.add(ball);

    const label = axisLabelSprite(AXIS_LETTER[axis], colorCss);
    label.position.copy(dir).multiplyScalar(shaftLen + ballR + 0.3);
    axisGizmoScene.add(label);
  }
  // Compact cube hub where the three axes meet — the recognisable "3ds Max
  // style" anchor, not just a dot the arrows happen to touch. A thin dark
  // edge outline keeps its corners readable at this tiny on-screen size.
  const hubSize = 0.34;
  const hub = new THREE.Mesh(new THREE.BoxGeometry(hubSize, hubSize, hubSize), new THREE.MeshBasicMaterial({ color: 0xd6d8de }));
  axisGizmoScene.add(hub);
  const hubEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(hub.geometry),
    new THREE.LineBasicMaterial({ color: 0x54565c }),
  );
  hub.add(hubEdges);
})();

function renderAxisGizmo() {
  // Mirrors the main camera's rotation only — a fixed-distance camera
  // looking at the origin from "the same direction" the main camera faces,
  // so the little triad always shows the current view orientation.
  const dist = 4;
  axisGizmoCamera.position.set(0, 0, 0).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion), dist);
  axisGizmoCamera.quaternion.copy(camera.quaternion);
  axisGizmoCamera.updateMatrixWorld();

  const dpr = renderer.getPixelRatio();
  const w = Math.round(AXIS_GIZMO_PX * dpr), h = Math.round(AXIS_GIZMO_PX * dpr);
  const x = Math.round((window.innerWidth - AXIS_GIZMO_PX - AXIS_GIZMO_MARGIN) * dpr);
  const y = Math.round((window.innerHeight - AXIS_GIZMO_PX - AXIS_GIZMO_MARGIN) * dpr);

  renderer.setScissorTest(true);
  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.render(axisGizmoScene, axisGizmoCamera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
}

// ---------------------------------------------------------------------------
// Room minimap — a schematic top-down floor plan (drawn straight with 2D
// canvas, not another 3D viewport: a real top-down camera would just see
// the ceiling), a dot for the camera's position and a wedge for which way
// it's facing — "where am I standing / which way am I looking" at a
// glance, on top of the free-look camera already covering "look around".
// Only shown while actually standing inside a room.
// ---------------------------------------------------------------------------
const minimapWrapEl = document.getElementById('minimapWrap');
const minimapCanvasEl = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvasEl.getContext('2d');
const minimapCoordsEl = document.getElementById('minimapCoords');

function updateMinimap() {
  const room = findRoomContainingCamera();
  if (!room) {
    minimapWrapEl.classList.add('hidden');
    return;
  }
  minimapWrapEl.classList.remove('hidden');

  const p = room.roomParams, c = room.roomCenter;
  const size = minimapCanvasEl.width; // backing-resolution square, CSS-scaled by style.css
  const pad = 18;
  const scale = Math.min((size - pad * 2) / p.width, (size - pad * 2) / p.length);
  const cx = size / 2, cy = size / 2;
  const rw = p.width * scale, rl = p.length * scale;

  const ctx = minimapCtx;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(131, 56, 236, 0.12)';
  ctx.fillRect(cx - rw / 2, cy - rl / 2, rw, rl);
  ctx.strokeStyle = 'rgba(244, 242, 248, 0.8)';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - rw / 2, cy - rl / 2, rw, rl);

  // Local room-space X/Z map straight onto minimap X/Y (top-down), same
  // convention the room itself is built with.
  const localX = camera.position.x - c.x, localZ = camera.position.z - c.z;
  const dotX = cx + localX * scale, dotY = cy + localZ * scale;

  // Facing wedge from yaw — matches faceDirection's forward vector
  // (-sin(yaw), 0, -cos(yaw)), so it always points the way the main view
  // is actually looking (horizontally; pitch doesn't affect a floor plan).
  const angle = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
  ctx.save();
  ctx.translate(dotX, dotY);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(13, 0);
  ctx.lineTo(-6, 6);
  ctx.lineTo(-6, -6);
  ctx.closePath();
  ctx.fillStyle = '#8338ec';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#8338ec';
  ctx.stroke();

  minimapCoordsEl.textContent = `X ${formatMm(localX, 0)} · Z ${formatMm(localZ, 0)} мм`;
}

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
    updateAxisLabels();
    updateHoleLabels();
    updateTileCutLabels();
    updateSpatialLineTypeLabels();
  } else if (mode === 'walk') {
    updateFreeCamera(dt, 0);
  }
  updateMinimap();
  renderer.render(scene, camera);
  renderAxisGizmo();
}
animate();

toast('Оберіть інструмент внизу, щоб додати перший об’єкт', 3200);

// Lightweight introspection hook for debugging in the browser console —
// harmless in production, handy on a real device or in automated checks.
window.__creslarnet3d = {
  get objects() { return objects; },
  get selected() { return selected; },
  scene, camera, renderer,
  buildProjectData, loadProject, select, canExplode, toggleExplode,
  createRoom, rebuildRoom, removeRoom, findRoomParts,
  get activeRoomId() { return activeRoomId; },
  get tileConfig() { return tileConfig; },
  set tileToolActive(v) { tileToolActive = v; },
  get tileToolActive() { return tileToolActive; },
  handleEditTap,
  get tileArea() { return tileArea; },
  commitTileArea, cancelTileArea,
  // fly the camera to look at a world point from a fixed relative offset —
  // handy for debugging/testing since there's no orbit pivot to aim any more
  lookAt(pos, distance = 3000) {
    const target = new THREE.Vector3(pos.x, pos.y, pos.z);
    const offset = new THREE.Vector3(0.35, 0.35, 1).normalize().multiplyScalar(distance);
    camera.position.copy(target).add(offset);
    faceDirection(new THREE.Vector3().subVectors(target, camera.position).normalize());
  },
  debugGizmo(x, y) {
    scene.updateMatrixWorld(true);
    const hits = rayFromClient(x, y).intersectObjects(gizmoMoveTargets.concat(gizmoRotateTargets), false);
    return {
      moveTargetCount: gizmoMoveTargets.length,
      rotateTargetCount: gizmoRotateTargets.length,
      hits: hits.map((h) => ({ axis: h.object.userData.gizmoAxis, isRotate: gizmoRotateTargets.includes(h.object), distance: h.distance })),
      moveDragActive: !!moveDragGizmo,
      rotateDragActive: !!rotateDragGizmo,
    };
  },
};
