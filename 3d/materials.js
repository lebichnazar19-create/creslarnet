// Procedural material factory: five surface types (glass, tile, fabric,
// wood, metal), each built from a small generated canvas texture so the
// whole project stays self-contained — no external image downloads,
// nothing for the service worker to miss when the phone is offline.
import * as THREE from './vendor/three/three.module.min.js';

function canvasTexture(size, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function tint(hex) { return new THREE.Color(hex); }

function tileTexture(color) {
  return canvasTexture(256, (ctx, s) => {
    const grout = '#c9c6bd';
    ctx.fillStyle = grout;
    ctx.fillRect(0, 0, s, s);
    const cell = s / 4;
    const gap = 4;
    ctx.fillStyle = `#${color.getHexString()}`;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        ctx.fillRect(x * cell + gap / 2, y * cell + gap / 2, cell - gap, cell - gap);
      }
    }
  });
}

function woodTexture(color) {
  return canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      const y = (i / 40) * s + (Math.sin(i * 12.9) * 4);
      const shade = i % 2 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = shade;
      ctx.lineWidth = 2 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= s; x += 16) {
        ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 3);
      }
      ctx.stroke();
    }
  });
}

function fabricTexture(color) {
  return canvasTexture(128, (ctx, s) => {
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= s; i += 4) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
    }
  });
}

function metalTexture(color) {
  return canvasTexture(128, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, `#${color.clone().offsetHSL(0, 0, 0.08).getHexString()}`);
    g.addColorStop(0.5, `#${color.getHexString()}`);
    g.addColorStop(1, `#${color.clone().offsetHSL(0, 0, -0.08).getHexString()}`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 30; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * s, 0);
      ctx.lineTo(Math.random() * s, s);
      ctx.stroke();
    }
  });
}

const REPEAT = { glass: 1, tile: 2, fabric: 3, wood: 1.5, metal: 1 };

export const MATERIAL_LABELS = {
  glass: 'Скло',
  tile: 'Плитка',
  fabric: 'Тканина',
  wood: 'Дерево',
  metal: 'Метал',
};

export function createMaterial(type, colorHex, envMap) {
  const color = tint(colorHex ?? defaultColor(type));

  let material;
  switch (type) {
    case 'glass':
      material = new THREE.MeshPhysicalMaterial({
        color,
        metalness: 0,
        roughness: 0.04,
        transmission: 1,
        thickness: 0.4,
        ior: 1.5,
        transparent: true,
        envMap,
        envMapIntensity: 1.2,
      });
      break;
    case 'tile': {
      const map = tileTexture(color);
      map.repeat.set(REPEAT.tile, REPEAT.tile);
      material = new THREE.MeshStandardMaterial({ map, roughness: 0.25, metalness: 0.05 });
      break;
    }
    case 'fabric': {
      const map = fabricTexture(color);
      map.repeat.set(REPEAT.fabric, REPEAT.fabric);
      material = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0 });
      break;
    }
    case 'wood': {
      const map = woodTexture(color);
      map.repeat.set(REPEAT.wood, REPEAT.wood);
      material = new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0 });
      break;
    }
    case 'metal': {
      const map = metalTexture(color);
      map.repeat.set(REPEAT.metal, REPEAT.metal);
      material = new THREE.MeshStandardMaterial({ map, roughness: 0.3, metalness: 1, envMap, envMapIntensity: 1 });
      break;
    }
    default:
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 });
  }
  material.userData.creslarnetType = type;
  material.userData.creslarnetColor = `#${color.getHexString()}`;
  return material;
}

function defaultColor(type) {
  return {
    glass: '#bfe3f0',
    tile: '#e8e4da',
    fabric: '#7d8fae',
    wood: '#9a6b3f',
    metal: '#a9adb3',
  }[type] ?? '#cccccc';
}

// Plain painted surface — used for freshly-added shapes and walls before
// (or instead of) a material from the palette above is applied.
export function createPaintMaterial(colorHex) {
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(colorHex), roughness: 0.75, metalness: 0.05 });
  material.userData.creslarnetType = 'paint';
  material.userData.creslarnetColor = colorHex;
  return material;
}
