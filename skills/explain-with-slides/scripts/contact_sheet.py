"""Tile slide screenshots 2x2 per image so many slides can be reviewed at once.

Usage: python contact_sheet.py <shots-dir> <out-dir>   (needs Pillow)
"""
import glob
import os
import sys

from PIL import Image

W, H = 800, 450
files = sorted(glob.glob(sys.argv[1] + "/s*.png"))
os.makedirs(sys.argv[2], exist_ok=True)
for k in range(0, len(files), 4):
    sheet = Image.new("RGB", (2 * W + 10, 2 * H + 10), "black")
    for j, f in enumerate(files[k:k + 4]):
        im = Image.open(f).convert("RGB").resize((W, H), Image.LANCZOS)
        sheet.paste(im, ((j % 2) * (W + 10), (j // 2) * (H + 10)))
    sheet.save(f"{sys.argv[2]}/sheet{k // 4 + 1:02d}.png")
print("sheets:", (len(files) + 3) // 4)
