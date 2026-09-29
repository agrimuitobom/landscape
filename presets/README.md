# リアル素材（presets/）

このフォルダに GLB を置いて `manifest.json` に登録すると、アプリのライブラリに
「リアル素材」として表示され、MR でそのまま配置できます。

## 1. 素材を入手する

| 入手先 | ライセンス | 向いている素材 | 注意 |
|---|---|---|---|
| **自分でスキャン**（Scaniverse / Polycam / RealityScan） | 自社 | 実際に据える岩・庭木・灯籠 | 最もおすすめ。現物そのものを確認できる |
| **Poly Haven**（polyhaven.com/models） | CC0 | 岩・石・丸太・切り株・樹木 | クレジット不要・商用可。ダウンロード時に形式 **glTF**・解像度 **1K** を選ぶ（初期値の Blend・4K では使えない） |
| **Sketchfab**（sketchfab.com） | 作品ごとに異なる | 石灯籠・蹲踞・竹垣などの和風素材 | **CC-BY はクレジット必須**。**NC（非営利）は業務で使えない** |

- 業務（施主への提案）で使う場合、**CC0 か CC-BY のみ**を使ってください。
- ダウンロードは **glTF / GLB 形式**を選んでください（FBX・OBJ はそのままでは読めません）。

## 2. Quest 向けに軽量化する（必須）

写真スキャン素材はそのままだと重く、Quest 3S では表示がカクつきます。
[gltf-transform](https://gltf-transform.dev/) で軽量化してから置いてください（Node.js が必要）。

```bash
npx @gltf-transform/cli optimize 元のファイル.glb presets/rock_moss_01.glb \
  --compress meshopt --texture-compress webp --texture-size 1024 \
  --simplify-ratio 0.5 --simplify-error 0.001
```

目安：**1個あたり 5万ポリゴン以下・ファイル 3MB 以下**。
ライブラリに「万△」でポリゴン数が表示されるので、30万を超えたら `--simplify-ratio` を小さくしてください。

- `.gltf`＋別ファイル（.bin / .jpg）の形式でダウンロードした場合も、上のコマンドで 1 つの `.glb` にまとまります。
- **Git LFS は使わないでください**（GitHub Pages が LFS のファイルを配信できないため）。

### 樹木はリーフカード方式で軽量化する

Poly Haven の樹木は葉を1枚ずつ立体で作ってあり、数百万ポリゴン・100MB 前後あります。
上の `--simplify` で減らすと葉がまばらになり、葉の画像の黒い背景も見えてしまうため、`tools/` のスクリプトを使います。

```bash
cd tools && npm install
# 1) 葉の色(leaves_diff)と透明マスク(leaves_alpha, png)を合成(Poly Haven の同じ素材ページから1Kで取得)
node make-leaf-rgba.mjs leaves_diff_1k.jpg leaves_alpha_1k.png leaves_rgba.png
# 2) 葉を「葉の形に切り抜いた板」に置き換え、幹・枝を簡略化
node optimize-tree.mjs tree_1k.gltf tree-geo.glb --leaf-texture leaves_rgba.png --keep 0.8
# 3) 画像と形状を圧縮
npx gltf-transform optimize tree-geo.glb ../presets/tree.glb --simplify false \
  --compress meshopt --texture-compress webp --texture-size 1024
```

- `--keep` は残す葉の割合です（0.8 で元の見た目に近く、約6万ポリゴン）。まばらなら上げ、重ければ下げます。
- 葉は材質に `foliage` の印が付き、アプリ側で裏から見ても暗くならないように表示されます。

### 「セット」素材から1つだけ取り出す

Poly Haven のシダ・若木・小石などは、数個が横に並んだ「セット」になっていることがあります。
そのままだと全部まとめて1個として置かれるので、`pick-part.mjs` で1つだけ取り出してから圧縮します。

```bash
cd tools && npm install
node pick-part.mjs fern_02_1k.gltf fern.glb xxx   # 名前が違うと、選べるノード名の一覧が表示されます
node pick-part.mjs fern_02_1k.gltf fern.glb fern_02_b
# 針葉樹など葉の板が多いもの: --thin で葉の板を間引く(残した板は少し大きくして密度を保つ)
node pick-part.mjs pine_sapling_small_1k.gltf pine.glb pine_sapling_small_a --thin 0.3
npx gltf-transform optimize pine.glb ../presets/pine.glb --simplify false \
  --compress meshopt --texture-compress webp --texture-size 1024
```

- 葉（透過する材質）には自動で `foliage` の印が付きます。
- ベンチ・プランターなど細部を近くで見ない物は `--texture-size 512` にすると軽くなります。

## 3. manifest.json に登録する

```json
{
  "models": [
    {
      "id": "rock-moss-01",
      "name": "苔岩（大）",
      "file": "rock_moss_01.glb",
      "credit": "Poly Haven",
      "license": "CC0",
      "kind": "andesite"
    },
    {
      "id": "lantern-kasuga",
      "name": "春日灯籠",
      "file": "lantern_kasuga.glb",
      "credit": "作者名 (Sketchfab)",
      "license": "CC-BY 4.0",
      "scale": 0.01
    }
  ]
}
```

| 項目 | 必須 | 説明 |
|---|---|---|
| `id` | ○ | 保存した配置がこの素材を参照するためのID。**一度決めたら変えない** |
| `name` | ○ | ライブラリに表示する名前 |
| `file` | ○ | このフォルダ内のファイル名 |
| `credit` / `license` | CC-BY なら必須 | ライブラリの素材名の下に表示されます |
| `scale` | − | 単位がずれている素材の補正（cm 単位で作られた素材なら `0.01`） |
| `kind` | − | 種類。石は `granite`（御影石 2.65）・`andesite`（一般の庭石 2.6）・`sandstone`（砂岩 2.3）で推定重量を表示。樹木は `decid`（落葉樹 年40cm）・`ever`（常緑樹 年30cm）・`shrub`（低木 年8cm）で「年数」切替時に成長の目安を表示 |
| `density` | − | 比重（t/m³）を直接指定する場合（`kind` より優先。樹木には書かない） |
| `category` | − | 素材パレットの分類を指定（`石`・`樹木`・`構造物`・`水・地面`）。省略時は `kind` から自動（石→石、樹木→樹木、それ以外→構造物）。切り株・丸太を「樹木」に入れる場合など |

- `name` は MR の素材パレットで**全角8文字程度**まで表示されます（高さは名前の下に自動で出るので、名前に寸法を入れなくて大丈夫です）。

置いたら GitHub に push し、GitHub Pages の更新後に Quest でページを再読み込みしてください。
ライブラリに表示される寸法（幅×奥行×高さ）が実物と合っているか必ず確認してください。
