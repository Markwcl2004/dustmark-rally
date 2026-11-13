# 环境色板（定稿 v1）

从每个环境选定的概念图上取色（中位数取样，框位见 `palettes_preview.jpg`）。机器可读版本：`public/assets/palettes.json`。
路肩 = 路面向暗植被混 30%；环境光 = 天空上下平均 × 0.75；地表乘色 groundTint = 阳光与地平线色 7:3 混合后把最亮通道拉到 255（接近白、带环境色相，乘在所有地表贴图上）。每张地表贴图精确对到色板的乘数见 `public/assets/tex/manifest.json` 的 `tint`。

## 北境林道（`nordic`）

概念图：`docs/art/concept_nordic.jpg`（源 `concept_nordic_1`）。光照：低角度晨光，左后方 ~25° 高度角。

| 用途 | 键 | 颜色 |
|---|---|---|
| 路面 | `road` | `#e6c9a7` |
| 路肩 | `shoulder` | `#b8a68a` |
| 植被亮 | `vegLight` | `#bca257` |
| 植被暗 | `vegDark` | `#4b5545` |
| 远景 | `distant` | `#99acab` |
| 天空上 | `skyTop` | `#c7d4c9` |
| 天空下/地平线 | `skyHorizon` | `#efe5cb` |
| 雾色 | `fogColor` | `#859c9b` |
| 阳光 | `sunColor` | `#ffe0a6` |
| 阴影 | `shadowColor` | `#324c6a` |
| 环境光 | `ambient` | `#a4a598` |
| 地表乘色 | `groundTint` | `#ffe6b4` |
| 岩石 | `rock` | `#8b8a7c` |

## 赤土高原（`savanna`）

概念图：`docs/art/concept_savanna.jpg`（源 `concept_savanna_1`）。光照：正午高光，几乎头顶 ~70° 高度角，短影。

| 用途 | 键 | 颜色 |
|---|---|---|
| 路面 | `road` | `#cd5025` |
| 路肩 | `shoulder` | `#af5222` |
| 植被亮 | `vegLight` | `#eab959` |
| 植被暗 | `vegDark` | `#69551b` |
| 远景 | `distant` | `#b79088` |
| 天空上 | `skyTop` | `#f0d2aa` |
| 天空下/地平线 | `skyHorizon` | `#efd1a8` |
| 雾色 | `fogColor` | `#d27e5a` |
| 阳光 | `sunColor` | `#fff0c8` |
| 阴影 | `shadowColor` | `#7a2e22` |
| 环境光 | `ambient` | `#b49d7f` |
| 地表乘色 | `groundTint` | `#ffebc2` |
| 岩石 | `rock` | `#b1502c` |

## 雪岭（`snow`）

概念图：`docs/art/concept_snow.jpg`（源 `concept_snow_1`）。光照：阴天漫射，太阳不可见；晴冷时段低角度侧光。

| 用途 | 键 | 颜色 |
|---|---|---|
| 路面 | `road` | `#fcfcf9` |
| 路肩 | `shoulder` | `#babbbe` |
| 植被亮 | `vegLight` | `#32364c` |
| 植被暗 | `vegDark` | `#202436` |
| 远景 | `distant` | `#bbb8cc` |
| 天空上 | `skyTop` | `#b0aec3` |
| 天空下/地平线 | `skyHorizon` | `#bdbace` |
| 雾色 | `fogColor` | `#9894af` |
| 阳光 | `sunColor` | `#f2eef8` |
| 阴影 | `shadowColor` | `#cbcfde` |
| 环境光 | `ambient` | `#898796` |
| 地表乘色 | `groundTint` | `#f5f1ff` |
| 岩石 | `rock` | `#3a3d4c` |

## 山海公路（`coast`）

概念图：`docs/art/concept_coast.jpg`（源 `concept_coast_1b`）。光照：晴，左上方 ~45° 高度角，海面反光。

| 用途 | 键 | 颜色 |
|---|---|---|
| 路面 | `road` | `#9c8f84` |
| 路肩 | `shoulder` | `#7a7669` |
| 植被亮 | `vegLight` | `#75752f` |
| 植被暗 | `vegDark` | `#2c3d2a` |
| 远景 | `distant` | `#7ea4b8` |
| 天空上 | `skyTop` | `#80b7cd` |
| 天空下/地平线 | `skyHorizon` | `#98c5d2` |
| 雾色 | `fogColor` | `#7ca2b4` |
| 阳光 | `sunColor` | `#f6eed6` |
| 阴影 | `shadowColor` | `#4a4a66` |
| 环境光 | `ambient` | `#698e9c` |
| 地表乘色 | `groundTint` | `#f6fff0` |
| 岩石 | `rock` | `#dcb38d` |
| 海 | `sea` | `#3887b4` |
