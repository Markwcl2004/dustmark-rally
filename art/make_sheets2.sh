#!/bin/sh
# Batch 2 review contact sheets: docs/art/sheet2_*.jpg (also refreshes the batch 1 nordic ground sheet, whose four textures were redone).
set -e
cd "$(dirname "$0")/.."
A=public/assets
D=docs/art
P=art/raw/tile_preview
T=$A/tex
mkdir -p $D

python3 art/sheet.py $D/sheet_ground_nordic.jpg --cols 4 --cell 420 --title "Nordic ground, 3x3 tiled" $(ls $P/nordic_*.jpg)
for e in savanna snow coast; do
  python3 art/sheet.py $D/sheet2_ground_$e.jpg --cols 4 --cell 420 --title "$e ground, 3x3 tiled" $(ls $P/${e}_*.jpg)
done
python3 art/sheet.py $D/sheet2_veg_savanna.jpg --checker --cols 5 --cell 300 --aspect 0.9 --title "Savanna vegetation (RGBA over checker)" $(ls $T/savanna/*.png)
python3 art/sheet.py $D/sheet2_veg_snow.jpg --checker --cols 4 --cell 300 --aspect 0.75 --title "Snow vegetation (RGBA over checker)" $(ls $T/snow/*.png)
python3 art/sheet.py $D/sheet2_veg_coast.jpg --checker --cols 5 --cell 300 --aspect 0.75 --title "Coast vegetation (RGBA over checker)" $(ls $T/coast/*.png)
python3 art/sheet.py $D/sheet2_veg_nordic.jpg --checker --cols 6 --cell 300 --aspect 1 --title "Nordic additions (RGBA over checker)" \
  $T/nordic/fern.png $T/nordic/fern_2.png $T/nordic/grass_tuft.png $T/nordic/grass_tuft_2.png $T/nordic/wildflowers.png \
  $T/nordic/wildflowers_2.png $T/nordic/reed.png $T/nordic/stump.png $T/nordic/log_pile.png $T/nordic/red_cabin.png
python3 art/sheet.py $D/sheet2_far.jpg --cols 1 --cell 1600 --title "Far layers x fog colour over skyHorizon (each row: two copies side by side)" $(ls $P/far_*.jpg)
python3 art/sheet.py $D/sheet2_sky.jpg --cols 2 --cell 800 --title "Skies + cloud bands 4:1, wrapped (each row: two copies)" \
  $P/sky_clear.jpg $(ls $P/sky_fog.jpg $P/sky_snowfall.jpg $P/sky_sandstorm.jpg $P/sky_sunset.jpg $P/sky_wet.jpg $P/sky_clouds_*.jpg)
python3 art/sheet.py $D/sheet2_crowd.jpg --checker --cols 4 --cell 360 --aspect 1.3 --title "Crowd 5-8 (RGBA over checker)" \
  $(ls $A/crowd/*_[5678].png)
python3 art/sheet.py $D/sheet2_staff.jpg --checker --cols 4 --cell 360 --aspect 1.0 --title "Marshals, photographers, van, tent" \
  $(ls $A/crowd/marshal_*.png $A/crowd/photographer_*.png $A/crowd/service_van.png $A/crowd/tent.png)
python3 art/sheet.py $D/sheet2_ui_cards.jpg --cols 3 --cell 520 --title "Car card backgrounds 3:2" $(ls $A/ui/card_bg_*.jpg)
python3 art/sheet.py $D/sheet2_ui_backgrounds.jpg --cols 3 --cell 560 --title "Menu / service / podium 16:10" \
  $(ls $A/ui/menu_bg_*.jpg) $A/ui/service_area.jpg $A/ui/podium_bg.jpg
python3 art/sheet.py $D/sheet2_ui_env.jpg --cols 2 --cell 800 --title "Event select 21:9" $(ls $A/ui/env_*_wide.jpg)
python3 art/sheet.py $D/sheet2_drivers.jpg --cols 6 --cell 256 --aspect 1 --title "Rival drivers 01-12" $(ls $A/ui/driver_*.png)
python3 art/sheet.py $D/sheet2_trophies.jpg --checker --cols 6 --cell 256 --aspect 1 --title "Trophies and medals (RGBA)" \
  $A/ui/trophy_gold.png $A/ui/trophy_silver.png $A/ui/trophy_bronze.png $A/ui/medal_gold.png $A/ui/medal_silver.png $A/ui/medal_bronze.png
ls -la $D | grep sheet2
