# 美术样张 v1（M1 并行任务）

画风：复古拉力海报。大色块、每环境限定色板、远景偏色发灰、水粉/丝网印颗粒。生成用 Z-Image Turbo，提示词和重跑方法见 `art/README.md`。

## 联系表

| 文件 | 内容 |
|---|---|
| `sheet_concepts.jpg` | 四环境定稿概念图（追尾视角） |
| `sheet_concepts_all.jpg` | 全部 20 张概念候选 |
| `sheet_palettes.jpg` | 取色框位 + 色板条（同 `palettes_preview.jpg`）；色值见 `palettes.md` |
| `sheet_ground_nordic.jpg` | 北境林道地表与树皮，每格是 3×3 平铺 |
| `sheet_ground_other.jpg` | 赤土 / 雪岭 / 山海 的路面和主地表，3×3 平铺 |
| `sheet_vegetation.jpg` | 北境叶片卡片、灌木、远景树公告板（棋盘格底看边缘） |
| `sheet_crowd.jpg` | 观众公告板 4 环境 × 4 组 |
| `sheet_sponsors.jpg` / `sheet_banners.jpg` / `sheet_decals.jpg` | 虚构赞助商标志、4:1 横幅、车贴图集 |
| `sheet_sky.jpg` | 四种天空，4:1 环绕全景（每行是两份首尾相接，看环绕） |
| `sheet_ui.jpg` | 标题主视觉、四张赛事海报、两张加载图 |
| `sheet_fx.jpg` | 粒子贴图 |

## 给接贴图的程序员

- 地表贴图（`public/assets/tex/<env>/*.jpg`，1024²）四向无缝，已去掉大尺度明暗，平均亮度按材质归一（砂石路 0.58、林下 0.36、雪 0.8 左右），可直接当 albedo。
  建议平铺尺寸、平均色和色相修正乘数在 `public/assets/tex/manifest.json`（`metresPerTile`、`tint`）。环境整体再乘 `palettes.json` 的 `groundTint`，天气/时段再乘一个系数。
- 单张贴图 3–4 m 一个周期，近处能看出重复：路面建议两张变体（`gravel_road_1/2`）用低频噪声混合，或加一层世界空间的大尺度明暗噪声。
- 路面贴图的方向：`savanna/road` 有沿 V 方向的浅车辙，请让 V 沿行车方向。其他无方向。
- 树皮：`pine_bark` / `birch_bark` 沿 V 为树干方向，建议 1.5 m 一个周期。
- RGBA 精灵（植被、观众）：已做颜色外扩，透明区 RGB 不是黑色，可以放心开 mipmap；用 alpha test（0.5）或 alpha-to-coverage。公告板和观众的脚/树根贴着画布底边。
- 天空 `sky/*.jpg` 是 3072×768（4:1）= 上半球等距柱状投影：u 绕一圈 360°，v 从底边地平线到顶边约 90°；不含太阳，太阳由渲染画。左右镜像拼成，u=0 和 u=0.5 两处对称。
- 车贴 `decals/atlas.json`：`px` 从左上角算，`uv` 的 v 从底边算（three.js 默认 flipY）。`roundel` / `number_panel` 是给车号用的空白底。
- 粒子 `fx/*.png` 是灰度 + alpha（LA），灰度是明暗，颜色在 shader 里乘。`dust_sheet` / `stones` 是 2×2 图集。
- 色板里的颜色取自概念图，是"受光后的最终色"，不是 albedo；雾色、天空色、阳光色可直接用，地表请用贴图本身 + `tint`。

---

# 美术素材第二批（M3/M4）

重跑方法和脚本见 `art/README.md`「第二批」一节。挑图记录在 `art/jobs/*2_picks.json`、`far_picks.json`、`sky2_picks.json`。

## 联系表（第二批）

| 文件 | 内容 |
|---|---|
| `sheet2_ground_{savanna,snow,coast}.jpg` | 新地表，每格是 3×3 平铺（含第一批的 road/ground） |
| `sheet_ground_nordic.jpg` | 已刷新：`rock` / `gravel_shoulder` / `grass` / `pine_bark` 为第二批重做版 |
| `sheet2_veg_{savanna,snow,coast,nordic}.jpg` | 植被公告板与小件（棋盘格底看边缘） |
| `sheet2_far.jpg` | 远景剪影 8 层，已乘环境 `distant` 色叠在 `skyHorizon` 上，每行两份首尾相接看环绕 |
| `sheet2_sky.jpg` | 新天空 6 张（含替换的 `clear`）+ 3 条云带（叠在渐变上），每行两份首尾相接 |
| `sheet2_crowd.jpg` / `sheet2_staff.jpg` | 观众 5–8 组 ×4 环境；裁判、摄影师、工作车、帐篷 |
| `sheet2_ui_cards.jpg` / `sheet2_ui_backgrounds.jpg` / `sheet2_ui_env.jpg` | 车卡背景、菜单/维修区/领奖台背景、赛事选择横图 |
| `sheet2_drivers.jpg` / `sheet2_trophies.jpg` | 12 个对手头像；奖杯、奖牌金银铜 |

## 给接素材的程序员（第二批）

- **地表新增**（1024²，四向无缝，均值亮度已按材质归一）：
  `savanna/{shoulder,dry_grass,rock,riverbed}`、`snow/{ice,snow_bank,rock_snow}`、
  `coast/{road_worn,shoulder,cliff_rock,stone_wall,terracotta_roof,plaster_wall,plaster_wall_ochre}`；
  `nordic/{rock,gravel_shoulder,grass,pine_bark}` 同名替换。平铺尺寸和 `tint` 在 `tex/manifest.json`（已重新生成）。
  - 墙面类 V 向上：`stone_wall` 一个周期 12 层石头（建议 2.4 m），`terracotta_roof` 8×8 片筒瓦（2 m，V 沿屋面坡向下），`plaster_*` 2 m。
  - `pine_bark` V 为树干方向（同第一批）。`snow/ice` 是低对比平涂冰面，反光请在材质里加（粗糙度低 / 加一点环境反射），贴图本身不画高光。
  - 岩石类（`savanna/rock`、`nordic/rock`、`coast/cliff_rock`、`snow/rock_snow`）是 Voronoi 底稿重绘的平涂块面，单块面较大，3×3 能看出重复：大面积崖壁请叠世界空间低频噪声或两种尺度混合。
- **植被**：`tex/<env>/*_billboard*.png` 是整树公告板（高 768–1024），其他是小件（宽 512）。根部贴画布底边、透明区已颜色外扩，同第一批（alpha test 0.5）。
  `snow_pine_billboard_3` 是"矮树"，但画布上并不比另外两棵小，矮靠世界尺寸设定（建议 1.5–2.5 m，另两棵 6–10 m）。
  `nordic/red_cabin.png` 是略带透视的正立面，适合远处公告板，不适合近景。`nordic/log_pile.png` 是端面朝外的侧视。
- **远景** `public/assets/far/<env>_{1,2}.png`：RGBA，底边是地面，u 方向无缝。**颜色是中性灰值层**（R=G=B，白 = 最淡最远）：
  渲染时 `rgb = texture * distant或fogColor`（palettes.json），再按距离向雾色混合。1 = 近层（值域 0.45–1），2 = 远层（0.65/0.7–1）。
  `savanna_*`、`coast_2` 是 2048×512（4:1）；`nordic_*`、`snow_*`、`coast_1` 是 4096×512（8:1，左右镜像拼的，见下方"不满意"）。按像素宽高比设置圆柱面上的重复次数，别拉成同一宽度。
  `coast_2` 底部 1/4 是海面色带（海平线是直的），放在海平面高度。
- **天空** `sky/*.jpg`：投影同第一批（3072×768 上半球）。新增 `fog`、`snowfall`、`sandstorm`、`sunset`、`wet`；`clear.jpg` 已替换为不镜像的版本（不再有 V 形）。
  这批的环绕方式是"末尾 30% 与开头交叉淡化"，不是镜像，所以没有对称点；代价是原画横向被拉宽约 1.3 倍。
  `snowfall` 上的雪点是静止的，真正的飘雪请继续用粒子。
- **云带** `sky/clouds_{1,2,3}.png`：2048×512 RGBA，u 无缝，1 = 积云、2 = 层云条、3 = 雨云（下方带雨丝）。可叠在程序渐变天空上缓慢横向滚动；颜色已去掉蓝底，边缘可直接 alpha 混合。
- **观众/人员**：`crowd/<env>_{5..8}.png` 高 512，脚贴底边；跳起的那组（`*_5`）脚也贴底边，需要的话程序里往上抬一点。
  `marshal_{1..3}`、`photographer_{1,2}`（1 是跪姿，高 400）、`service_van`（侧视，宽 1058）、`tent`（正视）都是 RGBA，脚/轮/桌腿贴底边。
- **界面**：`card_bg_{1..6}.jpg` 1536×1024，主色依次 橙 / 青绿 / 芥黄 / 红 / 钴蓝 / 森林绿，中间偏空。
  `menu_bg_{1..3}.jpg` 1920×1200 已压暗（乘 0.55–0.65、对比 0.7），可直接叠白字。`service_area.jpg` 中间留空放 3D 车（后墙脚大约在画面一半高度，前景地面是空的）。
  `podium_bg.jpg` 领奖台上有一个印刷体"1"字样（模型画的真数字，不是乱码），不想要可以在 UI 里用元素盖住。
  `env_<env>_wide.jpg` 2240×960（21:9），无车无字。`driver_{01..12}.png` 512² 不透明（带纯色底）。`trophy_*`/`medal_*` RGBA，银铜是从金色版按色相重映射出来的，形状一致。
