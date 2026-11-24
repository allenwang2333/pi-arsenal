"""Extract PDF text with page markers.

Usage: python -I pdf_text.py <paper.pdf> <out.txt>   (needs PyMuPDF)
"""
import sys

import pymupdf

doc = pymupdf.open(sys.argv[1])
with open(sys.argv[2], "w") as f:
    for i, page in enumerate(doc):
        f.write(f"\n===== PAGE {i + 1} =====\n")
        f.write(page.get_text())
print("pages:", len(doc))
