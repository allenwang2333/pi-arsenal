"""Crop a vector figure from a PDF page, using its caption to find it.

Usage:
  python -I crop_figure.py <paper.pdf> <page> <figure-number> <out.png>
      [--panel left|right] [--below "Figure 7:"] [--dpi 250]

The figure is the union of vector drawings above the "Figure N:" caption,
grown to include nearby label text. --below keeps only drawings under another
caption (two figures on one page). --panel keeps one half of a two-panel
figure. Always inspect the result.  (needs PyMuPDF)
"""
import argparse

import pymupdf

ap = argparse.ArgumentParser()
ap.add_argument("pdf")
ap.add_argument("page", type=int)
ap.add_argument("figure", type=int)
ap.add_argument("out")
ap.add_argument("--panel", choices=["left", "right"])
ap.add_argument("--below")
ap.add_argument("--dpi", type=int, default=250)
args = ap.parse_args()

page = pymupdf.open(args.pdf)[args.page - 1]
hits = page.search_for(f"Figure {args.figure}:")
if not hits:
    raise SystemExit(f"caption 'Figure {args.figure}:' not found on page {args.page}")
cap = hits[0]

rects = [d["rect"] for d in page.get_drawings() if d["rect"].y1 <= cap.y0 + 1]
if args.below:
    top = page.search_for(args.below)[0]
    blocks = [b for b in page.get_text("blocks") if top.y0 - 1 <= b[1] < top.y0 + 60]
    rects = [r for r in rects if r.y0 > max(b[3] for b in blocks)]


def union(rs):
    u = pymupdf.Rect()
    for r in rs:
        u.include_rect(r)
    return u


u = union(rects)
mid = (u.x0 + u.x1) / 2
if args.panel:
    if args.panel == "right":
        rects = [r for r in rects if r.x0 >= mid - 5]
    else:
        rects = [r for r in rects if r.x1 <= mid + 5]
    u = union(rects)

# Tick labels, legends, and axis titles are text, not drawings.
grow = pymupdf.Rect(u.x0 - 30, u.y0 - 6, u.x1 + 30, min(u.y1 + 22, cap.y0 - 1))
for b in page.get_text("blocks"):
    br = pymupdf.Rect(b[:4])
    if args.panel == "left" and br.x1 > mid + 5:
        continue
    if args.panel == "right" and br.x0 < mid - 5:
        continue
    if br.y1 <= cap.y0 and br in grow:
        u.include_rect(br)

pad = 4
clip = pymupdf.Rect(u.x0 - pad, u.y0 - pad, u.x1 + pad, u.y1 + pad) & page.rect
page.get_pixmap(dpi=args.dpi, clip=clip).save(args.out)
print(args.out, [round(v) for v in clip])
