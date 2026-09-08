#!/usr/bin/env python3
"""Rebuild full-frame portrait derivatives from the repository master (Pillow 11.3)."""
from pathlib import Path
from PIL import Image
R=Path(__file__).resolve().parents[1]
with Image.open(R/'assets/chen-huiwen.png') as master:
 for width in (240,480,800):
  image=master.resize((width,round(master.height*width/master.width)),Image.Resampling.LANCZOS)
  image.save(R/f'assets/chen-huiwen-{width}.webp',quality=86,method=6)
  image.save(R/f'assets/chen-huiwen-{width}.avif',quality=75,speed=6)
