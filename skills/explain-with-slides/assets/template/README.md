# Slide template

reveal.js template in the style of the Switch Transformers talk: white theme,
navy headings, small uppercase section labels, tinted callout boxes, compact
tables, inline SVG diagrams, and KaTeX math. 1280×720, works offline.

## Use

```sh
cp -R <this folder> my-talk && cd my-talk
npm install
open index.html        # press S for speaker notes, Esc for overview
```

`index.html` is a gallery: each slide is one layout. Copy the slides you need,
replace the placeholder text, and delete the rest. Every slide's notes start
with `Layout: …` and say when to use it.

## Layouts

| # | Layout | Use for |
|---|---|---|
| 1 | Title | Paper title, authors, venue, presenter |
| 2 | One sentence + roadmap | The idea to remember; section timing |
| 3 | Timeline + context/gap | What prior work found and what it left open |
| 4 | Text + before/after block diagram | Where the change sits in a known system |
| 5 | Definitions + comparison table | Background formulas with a size/cost table |
| 6 | Problem → answer table | Barriers and the paper's fix for each |
| 7 | Step-by-step diagram (fragments) | Walking one input through the core mechanism |
| 8 | Old vs new contrast boxes | The one detail that differs from prior work |
| 9 | Numbered reasons + box | Benefits of a design choice |
| 10 | Highlighted data table | One comparison that matters |
| 11 | Step story + bar chart | Measure → Score → Fix instead of a derivation |
| 12 | Text + table + flow diagram | What runs where, in what precision |
| 13 | Results table | Main comparison with an honest exception |
| 14 | Two titled tables | Two smaller tricks with their evidence |
| 15 | Recipe card | Summary of the method |
| 16 | Wide figure + highlight number | Headline plot from the source |
| 17 | Two figures side by side | Two views of the same result |
| 18 | Claim check | Return to the hypothesis with the source's numbers |
| 19 | Takeaways | Five numbered points |
| 20 | Strengths vs limitations | Your assessment |
| 21 | Discussion questions | Questions for the class |
| 22 | Closing | One sentence again, citation |
| 23 | Backup: code | Short, runnable code |
| 24 | Backup: later work | Context beyond the source |

## Style kit (`css/custom.css`)

- Section label: `<p class="kicker">2 · Method</p>` above each `<h2>`.
- Columns: `cols` (equal), `c64`, `c46`, `c3`.
- Boxes: `box`, plus `good` (green), `warn` (orange), `bad` (red).
- Text: `big`, `small`, `tiny`, `muted`, `center`, `red`, `src` (source line).
- Tables: cells `num`, `win`, `lose`; rows `hl` (highlight), `dim`;
  table `nowrap1` keeps the first column on one line.
- Timeline: `timeline` with child `div`s; `now` and `later` mark them.
- Figures: `<div class="figph" data-src="figures/x.png" data-caption="…">`
  shows a placeholder until the file exists, then the image with its caption.
  Wrap in `<div class="fig-wide" style="--fig-h: 360px;">` for full width.
- SVG diagrams: `svg.diagram` with `node` (`ffn`, `router`, `off`, `pick`),
  `edge` (`off`, `pick`), `group`, and text `lbl` (`s`, `b`). Expert colors
  are `--e1` to `--e4`. Give each SVG its own marker ids. Inline `style`
  fills override text color classes inside SVG.
- Backup tag: `<span class="backup-tag">Q&amp;A</span>` in the kicker.
