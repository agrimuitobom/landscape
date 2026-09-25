// 樹木の glTF(Poly Haven など)を Quest 向けに軽量化する。
// - 葉: 葉(連結成分)ごとに、テクスチャ上の範囲を覆う四角い板1枚(2三角形)に置き換える「リーフカード」方式。
//        葉の形は透明マスク付きの画像(make-leaf-rgba.mjs で作る)で切り抜く
// - 幹・枝: meshoptimizer で形を保ったまま三角形を減らす
// 例) node optimize-tree.mjs in.gltf out.glb --leaf-texture leaves_rgba.png --keep 0.8 --branch 0.08 --trunk 0.18
//     その後 gltf-transform optimize で WebP 圧縮・meshopt 圧縮をかける(presets/README.md 参照)
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplifyPrimitive, dedup, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const [input, output] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const opt = { keep: 0.8, branch: 0.08, trunk: 0.18, cutoff: 0.3, tint: 0.72, 'leaf-texture': '' };
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) {
  const k = args[i].slice(2), v = args[++i];
  opt[k] = k === 'leaf-texture' ? v : Number(v);
}
if (!input || !output || !opt['leaf-texture']) {
  console.error('usage: node optimize-tree.mjs in.gltf out.glb --leaf-texture leaves_rgba.png [--keep 0.8] [--branch 0.08] [--trunk 0.18] [--cutoff 0.3] [--tint 0.72]');
  process.exit(1);
}

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);

let seed = 12345;   // 毎回同じ結果になるよう固定の乱数で葉を選ぶ
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const tris = (p) => p.getIndices().getCount() / 3;

for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
  const name = p.getMaterial().getName();
  p.setAttribute('TEXCOORD_1', null);   // 未使用のUV2は捨てる
  const before = tris(p);
  if (name.endsWith('leaves')) {
    // リーフカード方式: 葉(連結成分)ごとに、テクスチャ上の範囲(UVの外接矩形)を覆う四角い板1枚に置き換える。
    // 板の3D位置は UV→位置 のアフィン変換を最小二乗で求め、葉の形は透明マスクで切り抜く
    const pos = p.getAttribute('POSITION'), uv = p.getAttribute('TEXCOORD_0'), a = p.getIndices().getArray();
    const n = pos.getCount(), parent = new Int32Array(n).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < a.length; i += 3) { const r = find(a[i]); parent[find(a[i + 1])] = r; parent[find(a[i + 2])] = r; }
    const comps = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); }
    const P = [], T = [], I = [], C = [];
    const pv = [0, 0, 0], tv = [0, 0];
    for (const verts of comps.values()) {
      if (rand() >= opt.keep) continue;
      // 正規方程式 (AᵀA) M = AᵀP を解く(A=[u v 1])
      const S = [[0,0,0],[0,0,0],[0,0,0]], B = [[0,0,0],[0,0,0],[0,0,0]];
      let umin = 1e9, umax = -1e9, vmin = 1e9, vmax = -1e9;
      for (const i of verts) {
        pos.getElement(i, pv); uv.getElement(i, tv);
        const row = [tv[0], tv[1], 1];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { S[r][c] += row[r] * row[c]; B[r][c] += row[r] * pv[c]; }
        umin = Math.min(umin, tv[0]); umax = Math.max(umax, tv[0]); vmin = Math.min(vmin, tv[1]); vmax = Math.max(vmax, tv[1]);
      }
      const det = S[0][0]*(S[1][1]*S[2][2]-S[1][2]*S[2][1]) - S[0][1]*(S[1][0]*S[2][2]-S[1][2]*S[2][0]) + S[0][2]*(S[1][0]*S[2][1]-S[1][1]*S[2][0]);
      if (Math.abs(det) < 1e-12) continue;
      const inv = [
        [(S[1][1]*S[2][2]-S[1][2]*S[2][1])/det, (S[0][2]*S[2][1]-S[0][1]*S[2][2])/det, (S[0][1]*S[1][2]-S[0][2]*S[1][1])/det],
        [(S[1][2]*S[2][0]-S[1][0]*S[2][2])/det, (S[0][0]*S[2][2]-S[0][2]*S[2][0])/det, (S[0][2]*S[1][0]-S[0][0]*S[1][2])/det],
        [(S[1][0]*S[2][1]-S[1][1]*S[2][0])/det, (S[0][1]*S[2][0]-S[0][0]*S[2][1])/det, (S[0][0]*S[1][1]-S[0][1]*S[1][0])/det]];
      const M = [0,1,2].map(r => [0,1,2].map(c => inv[r][0]*B[0][c] + inv[r][1]*B[1][c] + inv[r][2]*B[2][c]));
      const at = (u, v) => [0,1,2].map(c => u * M[0][c] + v * M[1][c] + M[2][c]);
      const base = P.length / 3;
      for (const [u, v] of [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]]) { P.push(...at(u, v)); T.push(u, v); }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      C.push(...at((umin + umax) / 2, (vmin + vmax) / 2));
    }
    // 法線: 樹冠の中心から外向き(やや上向き)。葉の裏表で暗くならないようアプリ側で反転を止める(extras.foliage)
    let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
    for (let i = 0; i < C.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], C[i+k]); mx[k] = Math.max(mx[k], C[i+k]); }
    const cc = [(mn[0]+mx[0])/2, mn[1] + (mx[1]-mn[1])*0.45, (mn[2]+mx[2])/2];
    const N = [];
    for (let q = 0; q < C.length / 3; q++) {
      const d = [C[q*3]-cc[0], C[q*3+1]-cc[1], C[q*3+2]-cc[2]], l = Math.hypot(...d) || 1;
      const nn = [d[0]/l, d[1]/l + 0.6, d[2]/l], l2 = Math.hypot(...nn) || 1;
      for (let k = 0; k < 4; k++) N.push(nn[0]/l2, nn[1]/l2, nn[2]/l2);
    }
    const buf = doc.getRoot().listBuffers()[0];
    p.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buf));
    p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(N)).setBuffer(buf));
    p.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(T)).setBuffer(buf));
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(I)).setBuffer(buf));
    const mat = p.getMaterial();
    const tex = doc.createTexture('leaves_rgba').setImage(fs.readFileSync(opt['leaf-texture'])).setMimeType('image/png');
    mat.setBaseColorTexture(tex).setAlphaMode('MASK').setAlphaCutoff(opt.cutoff).setDoubleSided(true).setNormalTexture(null);
    const k = opt.tint;   // 樹冠内部の陰りの代わりに葉を少し暗くする
    mat.setBaseColorFactor([k, k, k, 1]);
    mat.setExtras({ ...(mat.getExtras() || {}), foliage: true });
  } else {
    const ratio = name.endsWith('branches') ? opt.branch : opt.trunk;
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: 0.004, lockBorder: false });
  }
  console.log(`${name}: ${before} → ${tris(p)} tris`);
}
await doc.transform(dedup(), prune());
let total = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) total += tris(p);
console.log('total tris:', total);
await io.write(output, doc);
