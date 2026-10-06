// スキャンした石・灯籠などから、写り込んだ地面を取り除いて本体だけにする
// usage: node crop-scan.mjs in.glb out.glb [--cut 0.03] [--keep 0.008] [--margin 0.015]
//   1) 地面の平面を自動で見つける(いちばん多くの点が乗る平面)
//   2) 地面から --cut(m) 以上高い部分のうち、いちばん大きいかたまり = 本体
//   3) 本体のすそを、地面から --keep(m) の高さまで広げて残す(接地部分がきれいに残る)。
//      ただし真上から見た本体の輪郭 + --margin(m) より外へは広げない(根元の草・小石を残さない)
//   4) 地面が水平・高さ0になるよう向きを直す(傾いた地面で撮っても真っすぐ置ける)
// 小石・草など本体から離れたものは消えます。取り出した後は README の手順どおり optimize で軽量化してください
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, compactPrimitive, transformPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args.splice(i, 2)[1]) : def; };
const CUT = opt('--cut', 0.03), KEEP = opt('--keep', 0.008), MARGIN = opt('--margin', 0.015);
const [input, output] = args;
if (!input || !output) {
  console.error('usage: node crop-scan.mjs in.glb out.glb [--cut 0.03] [--keep 0.008] [--margin 0.015]');
  process.exit(1);
}

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(input);
const root = doc.getRoot();

// ノードの変換を頂点に焼き込み、すべての三角形を1つの座標系で扱う
const prims = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const p of mesh.listPrimitives()) { transformPrimitive(p, m); prims.push(p); }
}
for (const node of root.listNodes()) node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
if (!prims.length) { console.error('メッシュがありません'); process.exit(1); }

// 全頂点(位置)を集める。UVの継ぎ目で分かれた頂点は位置でまとめて、つながりを判定する
const P = [];             // [x,y,z] の配列(全プリミティブ通し)
const welded = [];        // 頂点 -> 位置でまとめた番号
const key = new Map();
const base = [];          // プリミティブごとの頂点番号の先頭
for (const p of prims) {
  base.push(P.length);
  const pos = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    const k = `${Math.round(v[0] * 2000)},${Math.round(v[1] * 2000)},${Math.round(v[2] * 2000)}`;   // 0.5mm
    if (!key.has(k)) key.set(k, key.size);
    welded.push(key.get(k));
    P.push([v[0], v[1], v[2]]);
  }
}

// 1) 地面の平面(RANSAC)。上向き(y>0)に近い平面だけを候補にする
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const sample = [];
for (let i = 0; i < Math.min(20000, P.length); i++) sample.push(P[Math.floor(rand() * P.length)]);
const TOL = 0.012;
let best = null;
for (let it = 0; it < 400; it++) {
  const [a, b, c] = [0, 1, 2].map(() => sample[Math.floor(rand() * sample.length)]);
  let n = norm(cross(sub(b, a), sub(c, a)));
  if (n[1] < 0) n = n.map(x => -x);
  if (n[1] < 0.8) continue;   // 37°より急な面は地面とみなさない
  const d = dot(n, a);
  let cnt = 0;
  for (const p of sample) if (Math.abs(dot(n, p) - d) < TOL) cnt++;
  if (!best || cnt > best.cnt) best = { n, d, cnt };
}
if (!best) { console.error('地面が見つかりませんでした'); process.exit(1); }
// 当てはまった点で平面を最小二乗で整える(y = ax + bz + c)
{
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sy = 0, sxy = 0, szy = 0, k = 0;
  for (const p of sample) {
    if (Math.abs(dot(best.n, p) - best.d) >= TOL) continue;
    const [x, y, z] = p;
    sxx += x * x; sxz += x * z; szz += z * z; sx += x; sz += z; sy += y; sxy += x * y; szy += z * y; k++;
  }
  const M = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, k]], B = [sxy, szy, sy];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) > 1e-12) {
    const sol = [0, 1, 2].map(j => det3(M.map((row, r) => row.map((v, c) => (c === j ? B[r] : v)))) / D);
    const n = norm([-sol[0], 1, -sol[1]]);
    best = { n, d: sol[2] * n[1], cnt: best.cnt };
  }
}
const tilt = Math.acos(best.n[1]) * 180 / Math.PI;
console.log(`地面: 傾き ${tilt.toFixed(1)}°・当てはまった点 ${Math.round(best.cnt / sample.length * 100)}%`);
const H = P.map(p => dot(best.n, p) - best.d);   // 地面からの高さ

// 2) 地面から CUT 以上高い三角形のかたまり(位置でつながったもの)のうち最大 = 本体
const tris = [];   // [prim, a, b, c(全体の頂点番号)]
prims.forEach((p, pi) => {
  const idx = p.getIndices().getArray();
  for (let i = 0; i < idx.length; i += 3) tris.push([pi, base[pi] + idx[i], base[pi] + idx[i + 1], base[pi] + idx[i + 2]]);
});
const triH = tris.map(([, a, b, c]) => (H[a] + H[b] + H[c]) / 3);
const area = (t) => { const [, a, b, c] = t; return Math.hypot(...cross(sub(P[b], P[a]), sub(P[c], P[a]))) / 2; };
// 位置でまとめた頂点 -> その頂点を含む三角形
const byVert = new Map();
tris.forEach((t, ti) => { for (const v of t.slice(1)) { const w = welded[v]; if (!byVert.has(w)) byVert.set(w, []); byVert.get(w).push(ti); } });
const neighbors = function* (ti) { for (const v of tris[ti].slice(1)) yield* byVert.get(welded[v]); };
const comp = new Int32Array(tris.length).fill(-1);
let bestComp = -1, bestArea = 0, nc = 0;
for (let ti = 0; ti < tris.length; ti++) {
  if (comp[ti] >= 0 || triH[ti] < CUT) continue;
  let a = 0;
  const stack = [ti];
  comp[ti] = nc;
  while (stack.length) {
    const t = stack.pop();
    a += area(tris[t]);
    for (const u of neighbors(t)) if (comp[u] < 0 && triH[u] >= CUT) { comp[u] = nc; stack.push(u); }
  }
  if (a > bestArea) { bestArea = a; bestComp = nc; }
  nc++;
}
if (bestComp < 0) { console.error(`地面から ${CUT * 100}cm 以上高い部分がありません(--cut を小さくしてください)`); process.exit(1); }
// 3) すそを KEEP の高さまで広げる。ただし本体を真上から見た輪郭(凸包)+MARGIN の内側だけ
//    (根元の草や、くっついた小石が外へはみ出して残らないように)
const e1 = norm(sub([1, 0, 0], best.n.map(x => x * best.n[0]))), e2 = cross(best.n, e1);
const to2 = (p) => [dot(p, e1), dot(p, e2)];
const hullPts = [];
tris.forEach((t, ti) => { if (comp[ti] === bestComp) for (const v of t.slice(1)) hullPts.push(to2(P[v])); });
hullPts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const cr2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const lower = [], upper = [];
for (const p of hullPts) { while (lower.length >= 2 && cr2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
for (let i = hullPts.length - 1; i >= 0; i--) { const p = hullPts[i]; while (upper.length >= 2 && cr2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
const hull = lower.slice(0, -1).concat(upper.slice(0, -1));   // 反時計回り
const inHull = (q) => hull.every((a, i) => {
  const b = hull[(i + 1) % hull.length], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
  return (ex * (q[1] - a[1]) - ey * (q[0] - a[0])) / l >= -MARGIN;
});
const centroid = (t) => { const [, a, b, c] = t; return [0, 1, 2].map(k => (P[a][k] + P[b][k] + P[c][k]) / 3); };
const keep = new Uint8Array(tris.length);
const stack = [];
for (let ti = 0; ti < tris.length; ti++) if (comp[ti] === bestComp) { keep[ti] = 1; stack.push(ti); }
while (stack.length) {
  const t = stack.pop();
  for (const u of neighbors(t)) if (!keep[u] && triH[u] >= KEEP && inHull(to2(centroid(tris[u])))) { keep[u] = 1; stack.push(u); }
}

let before = 0, after = 0;
prims.forEach((p, pi) => {
  const out = [];
  tris.forEach((t, ti) => { if (t[0] === pi && keep[ti]) out.push(t[1] - base[pi], t[2] - base[pi], t[3] - base[pi]); });
  before += p.getIndices().getCount() / 3;
  after += out.length / 3;
  p.getIndices().setArray(new Uint32Array(out));
  compactPrimitive(p);
});

// 4) 地面を水平・高さ0に。本体の中心を原点へ
const n = best.n, up = [0, 1, 0];
const axis = norm(cross(n, up)), ang = Math.acos(Math.min(1, dot(n, up)));
const [ux, uy, uz] = axis, cs = Math.cos(ang), sn = Math.sin(ang), t1 = 1 - cs;
const R = tilt < 0.05 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [
  [t1 * ux * ux + cs, t1 * ux * uy - sn * uz, t1 * ux * uz + sn * uy],
  [t1 * ux * uy + sn * uz, t1 * uy * uy + cs, t1 * uy * uz - sn * ux],
  [t1 * ux * uz - sn * uy, t1 * uy * uz + sn * ux, t1 * uz * uz + cs]];
let cx = 0, cz = 0, cnt = 0;
for (const p of prims) {
  const pos = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); const r = R.map(row => dot(row, v)); cx += r[0]; cz += r[2]; cnt++; }
}
cx /= cnt; cz /= cnt;
const ty = -best.d;   // 回転後、地面は y = d(nを上に向けたので)
const mat = [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, -cx, ty, -cz, 1];
for (const p of prims) transformPrimitive(p, mat);

await doc.transform(prune(), dedup());
let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const p of prims) {
  const pos = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
  }
}
console.log(`三角形 ${before} → ${after}`);
console.log(`本体の大きさ: 幅${(maxX - minX).toFixed(2)}m × 奥行${(maxZ - minZ).toFixed(2)}m × 高さ${(maxY - Math.max(0, minY)).toFixed(2)}m(地面より上)`);
await io.write(output, doc);
console.log('書き出し:', output);
