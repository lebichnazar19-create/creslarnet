// Compact BSP-tree boolean geometry (CSG) for THREE.BufferGeometry.
// Implements the classic polygon-clipping boolean algorithm (the technique
// behind most browser CSG libraries), built from scratch against plain
// vertex/plane/polygon structures so it needs nothing beyond THREE's own
// math classes. Used for cutting holes in pipes and window openings in
// walls. See test coverage in the project notes before touching the
// splitting logic — it is easy to look right and be subtly wrong.
import * as THREE from './vendor/three/three.module.min.js';

const EPSILON = 1e-5;
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

class Vertex {
  constructor(pos, normal) {
    this.pos = pos.clone();
    this.normal = normal.clone();
  }
  clone() { return new Vertex(this.pos, this.normal); }
  flip() { this.normal.negate(); }
  interpolate(other, t) {
    return new Vertex(
      this.pos.clone().lerp(other.pos, t),
      this.normal.clone().lerp(other.normal, t).normalize()
    );
  }
}

class Plane {
  constructor(normal, w) { this.normal = normal; this.w = w; }
  static fromPoints(a, b, c) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    return new Plane(n, n.dot(a));
  }
  clone() { return new Plane(this.normal.clone(), this.w); }
  flip() { this.normal.negate(); this.w = -this.w; }

  splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
    let polygonType = 0;
    const types = [];
    for (const v of polygon.vertices) {
      const t = this.normal.dot(v.pos) - this.w;
      const type = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    switch (polygonType) {
      case COPLANAR:
        (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      case SPANNING: {
        const f = [], b = [];
        for (let i = 0; i < polygon.vertices.length; i++) {
          const j = (i + 1) % polygon.vertices.length;
          const ti = types[i], tj = types[j];
          const vi = polygon.vertices[i], vj = polygon.vertices[j];
          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);
          if ((ti | tj) === SPANNING) {
            const t = (this.w - this.normal.dot(vi.pos)) / this.normal.dot(new THREE.Vector3().subVectors(vj.pos, vi.pos));
            const v = vi.interpolate(vj, t);
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) front.push(new Polygon(f));
        if (b.length >= 3) back.push(new Polygon(b));
        break;
      }
    }
  }
}

class Polygon {
  constructor(vertices) {
    this.vertices = vertices;
    this.plane = Plane.fromPoints(vertices[0].pos, vertices[1].pos, vertices[2].pos);
  }
  clone() { return new Polygon(this.vertices.map(v => v.clone())); }
  flip() {
    this.vertices.reverse();
    this.vertices.forEach(v => v.flip());
    this.plane.flip();
  }
}

class Node {
  constructor(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons) this.build(polygons);
  }

  invert() {
    for (const p of this.polygons) p.flip();
    if (this.plane) this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    const tmp = this.front; this.front = this.back; this.back = tmp;
  }

  clipPolygons(polygons) {
    if (!this.plane) return polygons.slice();
    let front = [], back = [];
    for (const p of polygons) this.plane.splitPolygon(p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  clipTo(bsp) {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }

  allPolygons() {
    let polygons = this.polygons.slice();
    if (this.front) polygons = polygons.concat(this.front.allPolygons());
    if (this.back) polygons = polygons.concat(this.back.allPolygons());
    return polygons;
  }

  build(polygons) {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();
    const front = [], back = [];
    for (const p of polygons) this.plane.splitPolygon(p, this.polygons, this.polygons, front, back);
    if (front.length) { if (!this.front) this.front = new Node(); this.front.build(front); }
    if (back.length) { if (!this.back) this.back = new Node(); this.back.build(back); }
  }
}

function polygonsFromGeometry(geometry, matrix) {
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const index = geometry.index;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const polygons = [];
  const triCount = index ? index.count / 3 : pos.count / 3;

  for (let t = 0; t < triCount; t++) {
    const verts = [];
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(t * 3 + k) : t * 3 + k;
      const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrix);
      const n = new THREE.Vector3(norm.getX(i), norm.getY(i), norm.getZ(i)).applyMatrix3(normalMatrix).normalize();
      verts.push(new Vertex(p, n));
    }
    const a = verts[0].pos, b = verts[1].pos, c = verts[2].pos;
    const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length();
    if (area > 1e-10) polygons.push(new Polygon(verts));
  }
  return polygons;
}

// Cheap triplanar-style UV so textured materials still map sanely onto
// freshly-cut faces that never went through a real unwrap: pick whichever
// world axis pair the face normal is least aligned with.
function triplanarUV(pos, normal) {
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  if (az >= ax && az >= ay) return [pos.x, pos.y];
  if (ay >= ax && ay >= az) return [pos.x, pos.z];
  return [pos.y, pos.z];
}

function geometryFromPolygons(polygons) {
  const positions = [];
  const normals = [];
  const uvs = [];
  for (const poly of polygons) {
    for (let i = 2; i < poly.vertices.length; i++) {
      const tri = [poly.vertices[0], poly.vertices[i - 1], poly.vertices[i]];
      for (const v of tri) {
        positions.push(v.pos.x, v.pos.y, v.pos.z);
        normals.push(v.normal.x, v.normal.y, v.normal.z);
        const [u, vCoord] = triplanarUV(v.pos, v.normal);
        uvs.push(u, vCoord);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

function booleanOp(op, meshA, meshB) {
  meshA.updateMatrixWorld(true);
  meshB.updateMatrixWorld(true);
  const toLocalA = new THREE.Matrix4().copy(meshA.matrixWorld).invert();

  const a = new Node(polygonsFromGeometry(meshA.geometry, meshA.matrixWorld));
  const b = new Node(polygonsFromGeometry(meshB.geometry, meshB.matrixWorld));
  const resultPolygons = op(a, b);

  for (const poly of resultPolygons) {
    for (const v of poly.vertices) v.pos.applyMatrix4(toLocalA);
  }
  return geometryFromPolygons(resultPolygons);
}

const ops = {
  subtract(a, b) {
    a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
    a.build(b.allPolygons()); a.invert();
    return a.allPolygons();
  },
  union(a, b) {
    a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
    a.build(b.allPolygons());
    return a.allPolygons();
  },
  intersect(a, b) {
    a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a);
    a.build(b.allPolygons()); a.invert();
    return a.allPolygons();
  },
};

export const CSG = {
  subtract: (meshA, meshB) => booleanOp(ops.subtract, meshA, meshB),
  union: (meshA, meshB) => booleanOp(ops.union, meshA, meshB),
  intersect: (meshA, meshB) => booleanOp(ops.intersect, meshA, meshB),
};
