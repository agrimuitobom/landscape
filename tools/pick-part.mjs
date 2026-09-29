// Poly Haven の「セット」素材(シダ・若木・石などが数個並んだもの)から1つだけ取り出す
// usage: node pick-part.mjs in.gltf out.glb <ノード名> [--thin 0.3] [--grow 1.3]
//   --thin : 葉の板(透過マスクの材質)を、葉1枚(連結成分)単位でこの割合だけ残す。針葉樹などポリゴンが多いとき用
//   --grow : 残した葉の板をそれぞれの中心で拡大する倍率(間引いた分の密度を補う。既定は間引き率から自動・上限1.5)
// 取り出した後は README の手順どおり gltf-transform optimize で圧縮してください
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, compactPrimitive } from '@gltf-transform/functions';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args.splice(i, 2)[1]) : def; };
const THIN = opt('--thin', 1);
const GROW = opt('--grow', Math.min(1.5, 1 / Math.sqrt(THIN)));
const [input, output, nodeName] = args;
if (!input || !output || !nodeName) {
  console.error('usage: node pick-part.mjs in.gltf out.glb <ノード名> [--thin 0.3] [--grow 1.3]');
  process.exit(1);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();
const nodes = root.listNodes();
const keep = nodes.find(n => n.getName() === nodeName);
if (!keep) {
  console.error(`ノード「${nodeName}」がありません。候補: ${nodes.filter(n => n.getMesh()).map(n => n.getName()).join(', ')}`);
  process.exit(1);
}
// 指定したノード以外のメッシュを外す(位置はアプリ側で底面中心に揃えるのでそのまま)
for (const n of nodes) if (n !== keep && n.getMesh() && !n.listChildren().includes(keep)) n.dispose();

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const tris = (p) => p.getIndices().getCount() / 3;
for (const p of keep.getMesh().listPrimitives()) {
  const mat = p.getMaterial();
  const cut = mat && mat.getAlphaMode() !== 'OPAQUE';
  if (cut) {
    // 半透明(BLEND)は奥行きの前後が乱れるので切り抜き(MASK)にし、裏から見ても暗くならない印を付ける
    if (mat.getAlphaMode() === 'BLEND') mat.setAlphaMode('MASK').setAlphaCutoff(0.5);
    mat.setExtras({ ...(mat.getExtras() || {}), foliage: true });
  }
  if (!cut || THIN >= 1) continue;
  const before = tris(p);
  const pos = p.getAttribute('POSITION'), idx = p.getIndices().getArray();
  const n = pos.getCount(), parent = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < idx.length; i += 3) { const r = find(idx[i]); parent[find(idx[i + 1])] = r; parent[find(idx[i + 2])] = r; }
  const kept = new Map();   // 連結成分の根 -> 残すか
  const center = new Map(); // 連結成分の根 -> 重心
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!kept.has(r)) { kept.set(r, rand() < THIN); center.set(r, [0, 0, 0, 0]); }
    pos.getElement(i, v);
    const c = center.get(r); c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; c[3]++;
  }
  for (let i = 0; i < n; i++) {
    const c = center.get(find(i));
    pos.getElement(i, v);
    pos.setElement(i, v.map((x, k) => c[k] / c[3] + (x - c[k] / c[3]) * GROW));
  }
  const out = [];
  for (let i = 0; i < idx.length; i += 3) if (kept.get(find(idx[i]))) out.push(idx[i], idx[i + 1], idx[i + 2]);
  p.getIndices().setArray(new Uint32Array(out));
  compactPrimitive(p);   // 使われなくなった頂点を詰める
  console.log(`${mat.getName()}: ${before} → ${tris(p)} tris (葉の板 ×${GROW.toFixed(2)})`);
}
await doc.transform(prune(), dedup());
await io.write(output, doc);
console.log('書き出し:', output);
