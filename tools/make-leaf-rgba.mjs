// usage: node make-leaf-rgba.mjs leaves_diff.jpg leaves_alpha.png leaves_rgba.png
// 葉の色(jpg)に透明マスク(png)を合成し、透明部分へ周囲の葉の色をにじませた RGBA PNG を作る
import sharp from 'sharp';
const [,, diffPath, alphaPath, out] = process.argv;
const { data: rgb, info } = await sharp(diffPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const { data: al, info: ai } = await sharp(alphaPath).resize(W, H).extractChannel(0).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
if(al.length !== W * H) throw new Error('alpha size mismatch ' + al.length + ' ' + JSON.stringify(ai));
// プッシュ・プル法: 不透明画素の色を粗い解像度へ集め、透明画素を粗い側から埋める
let levels = [{ w: W, h: H, c: new Float32Array(W * H * 3), m: new Float32Array(W * H) }];
for (let i = 0; i < W * H; i++) { const m = al[i] > 127 ? 1 : 0; levels[0].m[i] = m; for (let k = 0; k < 3; k++) levels[0].c[i * 3 + k] = rgb[i * 3 + k] * m; }
while (levels.at(-1).w > 1) {
  const s = levels.at(-1), w = Math.max(1, s.w >> 1), h = Math.max(1, s.h >> 1);
  const d = { w, h, c: new Float32Array(w * h * 3), m: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0; const c = [0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(s.w - 1, x * 2 + dx), sy = Math.min(s.h - 1, y * 2 + dy), j = sy * s.w + sx;
      m += s.m[j]; for (let k = 0; k < 3; k++) c[k] += s.c[j * 3 + k];
    }
    const j = y * w + x; d.m[j] = m; for (let k = 0; k < 3; k++) d.c[j * 3 + k] = c[k];
  }
  levels.push(d);
}
for (let L = levels.length - 2; L >= 0; L--) {   // 粗い段から順に、空の画素を埋める
  const s = levels[L], p = levels[L + 1];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const j = y * s.w + x;
    if (s.m[j] > 0) continue;
    const pj = Math.min(p.h - 1, y >> 1) * p.w + Math.min(p.w - 1, x >> 1);
    const pm = p.m[pj] || 1;
    for (let k = 0; k < 3; k++) s.c[j * 3 + k] = p.c[pj * 3 + k] / pm;
    s.m[j] = 1;
  }
  if (L > 0) for (let j = 0; j < s.w * s.h; j++) if (s.m[j] > 1) { for (let k = 0; k < 3; k++) s.c[j * 3 + k] /= s.m[j]; s.m[j] = 1; }
}
const outBuf = Buffer.alloc(W * H * 4);
const base = levels[0];
for (let i = 0; i < W * H; i++) {
  const m = al[i] > 127;
  for (let k = 0; k < 3; k++) outBuf[i * 4 + k] = m ? rgb[i * 3 + k] : Math.round(base.c[i * 3 + k]);
  outBuf[i * 4 + 3] = al[i];
}
await sharp(outBuf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(out);
console.log('wrote', out);
