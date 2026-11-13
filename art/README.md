# DUSTMARK 美术管线

所有素材都能从这里重跑。生成在 3080Ti 机器的 ComfyUI 上（地址用环境变量 `COMFY_HOST` 指定，默认 `http://127.0.0.1:8188`），文件落在本机。
`art/raw/` 是原图和中间文件（不入库），成品在 `public/assets/`，样张和联系表在 `docs/art/`。

## 环境与注意

- 系统 python3（3.9）+ Pillow + numpy：`python3 -m pip install --user pillow numpy -i https://pypi.tuna.tsinghua.edu.cn/simple`
- `comfy.py` 已绕开本机 HTTP 代理（`ProxyHandler({})`）。不要去掉 Qwen 改图里的 `ModelAttentionBackend: pytorch attention`。
- 出图和抠图分两轮跑（同轮会爆显存）：`cut: true` 的任务会先全部出图、`/free` 后再抠。
- 服务器同时是视频机：不要重启 ComfyUI、不要清队列；有别人的任务时我们的任务自动排在后面。
  服务器上的痕迹只有 `input/dm_*` 上传图和 `output/dustmark/`。
- 已存在的输出会被跳过：想重出某张，删掉 `art/raw/...` 里对应的 png 再跑。
- 实测一张 1024² 文生图约 20 秒（含排队和下载），1920×960 约 40 秒，抠图约 1 秒一张。

## 工具

| 脚本 | 作用 |
|---|---|
| `comfy.py t2i/edit/inpaint/cut jobs.json outdir [名前缀...]` | 提交任务并下载结果。jobs 文件可以是 `{style, suffix, defaults, jobs}`，实际提示词 = style + prompt + suffix。`inpaint` 用全白 mask 就是图生图 |
| `procbase.py` | 程序化底稿：砂石、碎石路肩、压实雪、海岸地面（再交给 Z-Image 图生图上色）；以及不经模型的成品：`snow/ground.jpg`、`nordic/birch_bark.jpg` |
| `seamless.py` | 无缝化（方法见文件头）：滚动半幅 → 用同材质变体按最小误差切割线拼补接缝（先横向、再纵向且切割线首尾相接）→ 去低频光照 → 按材质归一亮度/对比度。`check` 比较环绕边差和内部差 |
| `make_ground.py jobs/ground_picks.json` | 对挑中的地表/树皮跑：图生图变体（denoise 0.6）→ `seamless.tile` → jpg + `raw/tile_preview/` 3×3 预览 |
| `make_sky.py` | 天空：去纸边和底部地平线条 → 左右镜像拼成 4:1 环绕全景 |
| `cutout.py` | 抠图清理：去背景色溢边、收 1px 边、裁到内容、底边对齐、透明区颜色外扩（防 mipmap 黑边）、可降饱和、超 400 KB 量化 |
| `post.py concepts/ui/crowd/veg` | 概念图/界面图去纸边、裁比例、涂掉伪文字；观众/植被按 picks 文件出成品 |
| `palette.py` | 从定稿概念图取色 → `public/assets/palettes.json`、`docs/art/palettes.md`、`docs/art/palettes_preview.jpg` |
| `manifest.py` | `public/assets/tex/manifest.json`：每张地表贴图的平均色、建议平铺尺寸、对色板的色相乘数 |
| `sponsors.py` | 12 个虚构赞助商（纯代码画，字体为系统自带）、6 条横幅、车贴图集 |
| `fx.py` | 粒子贴图（程序生成） |
| `sheet.py` / `make_sheets.sh` | 联系表 / 重做全部 `docs/art/sheet_*.jpg` |

## 风格前缀（补素材时保持一致）

**画面类**（概念图、海报、标题、加载图、观众、植被、天空），见 `jobs/concept.json`、`jobs/ui.json` 的 `style`：

> Vintage 1970s rally racing poster illustration, flat gouache painting with silkscreen print grain, bold simplified color blocks,
> limited palette, graphic stylized shapes, matte paper texture, not photorealistic, no glossy plastic look.
> （有远景时再加）Strong atmospheric perspective where each distant layer fades into colored haze.

画面里有车时加后缀（虚构、无商标、无字）：

> The rally car is a fictional unbranded generic 1980s style boxy rally hatchback with plain two-tone livery stripes and blank
> white door roundels, no logos, no badges, no text, no letters, no numbers. Full bleed image with no border, no frame, no title,
> no caption, no watermark, no signature.

单体素材（观众、树、灌木、叶片）结尾加：`Isolated on a plain flat uniform light grey background, nothing else in the image, no ground shadow, no text, no border.`

**地表贴图类**，见 `jobs/ground.json` 的 `style`：

> Overhead close-up gouache painting looking straight down at the ground from directly above, like a top-down map, the entire
> canvas is densely covered edge to edge, flat even soft overcast daylight with no cast shadows, stylised illustration with
> simplified painted shapes and fine brush grain, muted natural colors.

## 踩过的坑（Z-Image Turbo）

- 提示词写 "seamless / tileable / texture / game texture" → 画成"中间空白四周装饰的方框"或瓷砖网格（`raw/ground_v1_rejected/`）。改成"俯视特写水粉画、满幅、均匀分布"才正常。无缝靠后处理，不靠提示词。
- 地表提示词里有 "road" → 模型会画出路边、车辙、石子堆在一角。路面类先用 `procbase.py` 画均匀底稿再图生图（denoise 0.5–0.6），变体提示词去掉 "road"。
- 图生图 denoise ≥ 0.6 时 Turbo 基本重新构图；0.5 才保住底稿的均匀分布。
- "poster" 提示词常带一圈纸边、顶部图钉点、角落伪签名；`post.trim_border` 自动裁掉。地表候选角上也会有伪签名（滚动半幅后会跑到正中间），挑图时要看四角，必要时 `crop`。
- 车尾/车头偶尔有伪字母牌：`post.patch` 涂掉（概念图 nordic 已处理）。
- 无缝化：直接重绘接缝十字会留下直边；整十字一次拼补会在带子触边处破坏环绕；最后用的是"先横后纵、纵向切割线首尾相接"的两遍拼补，并把补丁的低频色调换成底图的（否则补丁带有色块）。
- 天空：拼补和重绘接缝都在大色块上留下明显竖带，改为左右镜像（4:1）。斜向云会在镜像点成 V 形，所以晴天/黄昏改用"水平云带"提示词重出。

## 各类素材怎么重跑

```sh
cd ~/rally
# 概念图 + 色板
python3 art/comfy.py t2i art/jobs/concept.json art/raw/concept
python3 art/post.py concepts && python3 art/palette.py
# 地表：候选 → 看图挑 → 写 jobs/ground_picks.json → 无缝化 → manifest
python3 art/procbase.py
python3 art/comfy.py t2i art/jobs/ground.json art/raw/ground
python3 art/comfy.py inpaint art/jobs/ground_img2img.json art/raw/ground
python3 art/make_ground.py art/jobs/ground_picks.json      # 也处理 pine_bark（源在 raw/veg）
python3 art/manifest.py
# 植被：叶片/灌木/公告板走抠图
python3 art/comfy.py t2i art/jobs/veg_nordic.json art/raw/veg && python3 art/post.py veg
# 观众
python3 art/comfy.py t2i art/jobs/crowd.json art/raw/crowd && python3 art/post.py crowd
# 天空
python3 art/comfy.py t2i art/jobs/sky.json art/raw/sky && python3 art/make_sky.py
# 界面美术
python3 art/comfy.py t2i art/jobs/ui.json art/raw/ui && python3 art/post.py ui
# 纯代码素材
python3 art/sponsors.py && python3 art/fx.py
# 联系表
sh art/make_sheets.sh
```

挑图结果都在 `jobs/*_picks.json`（输出路径 → 源候选名 + 参数），换图只改这些文件再重跑对应步骤。

## 第二批（M3/M4 素材）

原图在 `art/raw/b2/<类别>/`。风格前缀不变（画面类 = 上面的海报前缀，地表 = 俯视水粉前缀）。新增脚本：

| 脚本 | 作用 |
|---|---|
| `procbase2.py` | 第二批程序化底稿（全部精确周期 1024²）：旧柏油、筒瓦屋顶、松树皮（竖向 Voronoi 树皮块）、细碎路肩（北境/赤土/山海）、干砌石墙、干河床、Voronoi 岩面（赤土/北境/雪岭/山海）、草/干草笔触；以及不经模型的成品底：白/赭石灰墙 |
| `seamless.py` 新增 `periodic_part` | Moisan 周期+平滑分解。图生图自周期底稿、结构仍对齐的贴图用它代替拼补（`ground2_picks.json` 里 `"method": "psd"`），屋顶瓦行、树皮竖纹不会被切割线打断 |
| `wrapx.py` | 横向环绕（不镜像、不需要变体）：挑与开头最像的结束列 → 每行线性去趋势 → 首尾重叠区最小误差切割。远景、天空、云带用 |
| `make_far.py` | 远景剪影：`far_picks.json` → `public/assets/far/<env>_{1,2}.png` |
| `make_sky2.py` | 4:1 天空（直接出 2048×512 再环绕）和 RGBA 云带：`sky2_picks.json` |
| `post2.py` | `cut <picks>`（植被/观众/人员/道具/奖杯抠图，`keep_largest` 去掉 BiRefNet 留下的碎块）、`ui <picks>`（全幅界面图：去纸边、裁比例、压暗/降对比）、`metals`（金奖杯/奖牌按色相重映射出银、铜） |

### 第二批踩的坑

- 地表文生图在 Z-Image 上总是"稀疏 + 构图"（一条小溪、一角石堆、一道大裂缝）。均匀的细碎材质一律走：`procbase2.py` 画周期底稿 → 图生图（denoise 0.35–0.55，越低越保留分布）→ 无缝化。denoise 0.6 以上模型会重新构图。
- 墙面/崖面带海报前缀文生图会画成"整面悬崖风景"或"装饰网格"（`raw/b2/ground/coast_plaster_*`、`coast_cliff_rock_[abc]`），所以石灰墙纯程序化，崖面走 Voronoi 底稿图生图。
- 雪景单体（挂雪树、雪灌木）背景改成中灰（`ISO_DARK`），浅灰底上白雪会被 BiRefNet 一起抠掉。
- 提示词里写 "no cars" 照样画车（题图、菜单背景），改用 Qwen-Image-Edit 擦车（`jobs/ui2_edit.json`），效果干净。
- 车卡背景模型只画干净色带，等高线/尘点/颗粒是 `post2.card_texture` 程序叠的。
- 金奖杯/奖牌出银铜不重新生成（形状会变），按色相重映射；奖牌丝带白条要排除（只认金色附近的高光）。
- 远景剪影：层层叠的山脊两端高度对不上，最小误差切割会留台阶，这几层（nordic、snow、coast_1）改为镜像拼成 8:1；赤土和 coast_2 用切割环绕。
- 天空：长条云带用切割环绕同样留台阶，改为末尾 30% 交叉淡化（`wrapx.wrap_fade`）。
- 抠图对象底下常带一小块"地面"色块（灌木、草丛），`cutout.py` 底边对齐后保留，看起来是根部的土，没有去。

### 第二批重跑

```sh
cd ~/rally
# 地表
python3 art/procbase2.py
python3 art/comfy.py t2i art/jobs/ground2.json art/raw/b2/ground          # 文生图候选（多数没选中，留作对照）
python3 art/comfy.py t2i art/jobs/surface2.json art/raw/b2/ground         # 墙/崖正视候选（石墙选中）
python3 art/comfy.py inpaint art/jobs/ground2_img2img.json art/raw/b2/ground
python3 art/make_ground.py art/jobs/ground2_picks.json && python3 art/manifest.py
# 植被
python3 art/comfy.py t2i art/jobs/veg2.json art/raw/b2/veg && python3 art/post2.py cut art/jobs/veg2_picks.json
# 远景
python3 art/comfy.py t2i art/jobs/far.json art/raw/b2/far && python3 art/make_far.py
# 天空 + 云带
python3 art/comfy.py t2i art/jobs/sky2.json art/raw/b2/sky && python3 art/make_sky2.py
# 观众 / 裁判 / 摄影师 / 工作车 / 帐篷
python3 art/comfy.py t2i art/jobs/crowd2.json art/raw/b2/crowd && python3 art/post2.py cut art/jobs/crowd2_picks.json
# 界面
python3 art/comfy.py t2i art/jobs/ui2.json art/raw/b2/ui && python3 art/comfy.py t2i art/jobs/ui2_portraits.json art/raw/b2/ui
python3 art/comfy.py edit art/jobs/ui2_edit.json art/raw/b2/ui      # Qwen 改图：把模型自己画进去的车擦掉（env coast/nordic、menu 1/2）
python3 art/post2.py ui art/jobs/ui2_picks.json && python3 art/post2.py cut art/jobs/ui2_cut_picks.json && python3 art/post2.py metals
# 联系表
sh art/make_sheets2.sh
```
