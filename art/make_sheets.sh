#!/bin/sh
# Rebuild the review contact sheets in docs/art/ from the finished assets.
set -e
cd "$(dirname "$0")/.."
A=public/assets
D=docs/art
P=art/raw/tile_preview
mkdir -p $D

python3 art/sheet.py $D/sheet_concepts.jpg --cols 2 --cell 800 --title "Concepts (picked, 1 per env)" \
  $D/concept_nordic.jpg $D/concept_savanna.jpg $D/concept_snow.jpg $D/concept_coast.jpg
python3 art/sheet.py $D/sheet_concepts_all.jpg --cols 4 --cell 420 --title "All concept candidates" art/raw/concept/concept_*.png
cp $D/palettes_preview.jpg $D/sheet_palettes.jpg

# ground: 3x3 tiling previews (each cell = 3x3 copies of one texture)
python3 art/sheet.py $D/sheet_ground_nordic.jpg --cols 4 --cell 420 --title "Nordic ground, 3x3 tiled" $(ls $P/nordic_*.jpg)
python3 art/sheet.py $D/sheet_ground_other.jpg --cols 4 --cell 420 --title "Savanna / Snow / Coast ground, 3x3 tiled" \
  $(ls $P/savanna_*.jpg $P/snow_*.jpg $P/coast_*.jpg)

python3 art/sheet.py $D/sheet_vegetation.jpg --checker --cols 5 --cell 300 --aspect 0.75 --title "Nordic vegetation (RGBA over checker)" \
  $(ls $A/tex/nordic/*.png)
python3 art/sheet.py $D/sheet_crowd.jpg --checker --cols 4 --cell 360 --aspect 1.3 --title "Crowd billboards (RGBA over checker)" \
  $(ls $A/crowd/*.png)
python3 art/sheet.py $D/sheet_sponsors.jpg --checker --cols 4 --cell 380 --aspect 2.6 --title "Fictional sponsors" \
  $(ls $A/sponsors/*.png)
python3 art/sheet.py $D/sheet_banners.jpg --cols 2 --cell 760 --title "Roadside banners 4:1" $(ls $A/sponsors/banner_*.jpg)
python3 art/sheet.py $D/sheet_decals.jpg --checker --cols 1 --cell 1000 --aspect 1 --title "Car decal atlas" $A/decals/atlas.png
python3 art/sheet.py $D/sheet_sky.jpg --cols 2 --cell 800 --title "Skies 4:1 mirror-wrapped (each row: two copies side by side)" $(ls $P/sky_*.jpg)
python3 art/sheet.py $D/sheet_ui.jpg --cols 4 --cell 420 --title "UI art" $(ls $A/ui/*.jpg)
python3 art/sheet.py $D/sheet_fx.jpg --checker --cols 5 --cell 256 --aspect 1 --title "Particles" $(ls $A/fx/*.png)
ls -la $D
