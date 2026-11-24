---
name: explain-with-slides
description: Build and refine a reveal.js slide deck with speaker notes that explains a paper, concept, or system to classmates. Use only when the user runs /skill:explain-with-slides.
disable-model-invocation: true
---

# Explain with slides

Build a slide deck that a classmate or undergraduate could learn from, then
refine it with the user slide by slide. The test of success: after the talk, a
listener can explain the main idea to someone else.

Clear explanation matters more than coverage or visual polish. Every claim must
come from the source or be marked as the presenter's own.

Bundled files (paths are relative to this skill directory):

- `assets/template/`: reveal.js deck template. `index.html` is a gallery of
  24 layouts (see `assets/template/README.md` for the catalog and style kit);
  `css/custom.css` styles it; `js/figures.js` swaps figure placeholders for
  images and adds source captions.
- `scripts/render_slides.sh`: screenshots slides with all fragments shown.
- `scripts/contact_sheet.py`: tiles screenshots 2×2 for fast review.
- `scripts/pdf_text.py`: extracts PDF text with page markers.
- `scripts/crop_figure.py`: crops a vector figure from a PDF by its caption.

The Python scripts need PyMuPDF and Pillow. Install them in a scratch venv
outside the deck (for example `/tmp/slides-venv`). Run Python on downloaded
files with `-I`.

## 1. Settle the request

Use the arguments as the topic or source. Ask once, in one question round, for
whatever is missing and matters:

- Source: paper URL or PDF, file, or topic.
- Audience and purpose (class paper presentation, team explainer).
- Talk length. Plan about 1 minute per main slide.
- Any instructor or course guidelines. If the user pastes guidelines in parts,
  wait for all parts before you plan.
- Output folder, and presenter name, course, and date for the title slide.

Defaults: reveal.js HTML, speaker notes on every slide, backup slides for Q&A,
own SVG diagrams, and source figures with attribution.

## 2. Read the source completely

- Put each download in its own new, empty directory. Keep scripts elsewhere.
- Extract the text with `scripts/pdf_text.py` and read all of it, including
  appendices. Note every table and figure with its page number.
- When the explanation compares the work with prior work, get the prior work
  too. Do not describe a prior paper from memory.

## 3. Plan the story

For a paper, follow the paper's own order:
problem → essential background → main idea and method → evidence → discussion.
Suggested time split: about 15% problem and background, 40–45% method, 25–30%
evidence, 15% discussion. Spend the most time on what is new, not on familiar
background.

For a concept or system: one sentence → how it works → worked example →
trade-offs → takeaway.

For a project proposal: why the problem matters → what goes wrong today →
what prior work did and what is still open → method → expected results →
plan and risks. Before you claim a gap, search for work from the last 12 months
and read the closest papers. Show a table of what is done and what is open.
Write expected results as "question → our guess → what it means if the guess
is wrong".

Give the motivation before the twist. Say why people do X before you say that
X has a hidden cost. Do not open with a conclusion that uses terms the audience
does not know yet.

Always include:

- A one-sentence summary near the start and again at the end.
- Context: what the work builds on, with a short timeline. Check dates before
  you claim which work came first.
- A slide that returns to the central hypothesis or claim and tests it against
  the source's own data. Say where the claim holds and where it does not.
- Strengths and limitations, plus 3–4 discussion questions.
- Backup slides for detail cut from the main talk. When the source lists
  several variants (for example, all parallelism strategies), cover them all:
  the main ones in the talk, the rest in backup, with a pointer from the main
  slide.

## 4. Write each slide

Accuracy:

- Take every number from the source. Cite the table, figure, or section.
- Mark your own examples and interpretations on the slide: "(mine)", "My
  reading", or "not from the paper".
- Do not present a mechanism as new when the prior work has it too. Find the
  real difference and show it side by side.
- If the source's wording is loose or wrong, say what actually happens. Example:
  "less router computation" was really "one expert FFN instead of k; the router
  costs the same".
- Check derived numbers yourself. When text and tables disagree, use the table
  and note the mismatch in the speaker notes.

Clarity:

- One idea per slide. The title states the claim.
- Replace derivations and gradients with a short step story (for example
  Measure → Score → Fix) and a worked example with concrete numbers. Put the
  formal math in the speaker notes for Q&A.
- When a formula stays on the slide, write every term, including terms that are
  zero. Break counts into named parts (4d² = Q, K, V, and output matrices).
- State cost formulas in plain words first ("traffic per device ≈ tokens ×
  capacity factor"). Put the symbolic form (E × C × d) in the notes.
- Define conventions that people often confuse (dropout 0.1 drops 10%).
- Use one running example across slides (same token, same probabilities).
- Draw engineering details as a diagram: what runs where, in what precision,
  and what crosses devices.
- If a slide does not serve the story, cut it or move it to backup. If it needs
  a long verbal explanation, simplify the slide.

Plain language:

- Define each term in one plain sentence before you use it. A classmate who
  missed the last slide must still follow this one.
- Replace jargon with what it means: "ablation" → "extra test with recall
  turned off"; "prefix rewritten" → "the cache breaks". Do not use a paper name
  as a description ("ARC-style"); say what the method does and cite the paper
  in the source line.
- Name a statistical test only next to its plain purpose ("McNemar test:
  compares solved / not solved on the same tasks").
- Write table headers as plain questions ("Can the agent get it back?"), not as
  internal labels ("Lost forever?", "Follows").

Worked examples:

- Open with a short story in steps ("Step 5: reads foo.py. Step 12: we remove
  it. Step 20: needs it again."), not one long setup sentence.
- Draw the thing that changes (for example, the prompt as a bar with labelled
  parts) so the audience sees where each number comes from. Prefer this to a
  table of abstract columns.
- Use real units (cents, seconds, GB). Do not invent units such as "cost unit =
  1k tokens".
- Show one new idea per click: the result first, then the pay-back, then the
  lesson.
- Tie every method slide to the running example (for example, a table column
  "What happens to foo.py").

Diagrams:

- Use one kind of box per row or lane (inputs, steps, or results), not a mix.
  Label each lane in plain words ("Offline: re-price recorded runs").
- Give every arrow a label that says what it means, or remove it.
- Prefer a concrete instance (one recorded run with numbered steps) to an
  abstract pipeline of boxes.

Figures:

- Draw core mechanisms as inline SVG diagrams. Give each SVG unique marker ids.
- Crop source figures with `scripts/crop_figure.py`, then look at every crop.
  Use `--panel` for one half of a two-panel figure and `--below "Figure K:"`
  when two figures share a page.
- Caption each source figure with its number, authors, year, and license (for
  example "CC BY 4.0") through the placeholder's `data-caption`.

Speaker notes:

- Short, plain sentences the presenter can say aloud.
- Start with a time estimate, such as `[~1.5 min]`. Mark each fragment with
  `[click]`.
- End with likely Q&A points and the formal details that were cut from the
  slide.

## 5. Build

1. Copy `assets/template/` to the output folder. Run `npm install` there, then
   `npm audit`.
2. Build the deck from the gallery: for each planned slide, copy the matching
   layout, replace its placeholder text, and delete unused layouts. Use only the
   classes in the template's style kit; do not add new styles unless a layout
   is missing.
3. Add a short `README.md`: how to open and present (`S` opens speaker view),
   the section and timing table, the figure list, and the file layout.
4. Run any code shown on slides and check its output.

## 6. Verify every change

- Render with `scripts/render_slides.sh <deck> <out-dir> [indexes]`. Indexes
  are 0-based. Use a new output folder or new file names for each round, so an
  image viewer cannot show a stale screenshot.
- Review with `scripts/contact_sheet.py` for full passes, or read single
  screenshots after small edits.
- Check for overflow, overlap with the navigation arrows, unreadable figures,
  awkward line breaks inside formulas, and duplicated elements.
- To check the first state of a slide with fragments, render it again without
  `?fragments=false`.
- Do a plain-language pass on every slide. Can a classmate say the slide's point
  in one sentence from the slide alone? Is any term used before it is defined?
  If not, fix the slide.
- Check that the running example agrees across slides: the same step numbers,
  sizes, and prices.
- KaTeX reads `$…$` in prose as math. Write prices as "0.30 USD", not "$0.30".
- Delete screenshots and scratch files when done.

## 7. Refine with the user

When the user questions or flags a slide:

1. Answer the question directly first, with a worked example if it helps.
2. If the user found a real error, say so plainly, check the source, and fix
   it. Never defend wording you cannot support.
3. Change the slide so the audience will not hit the same confusion, and
   update its speaker notes.
4. Check the other slides for the same problem (jargon, abstract units, mixed
   diagrams), and fix those too. Say which slides you changed.
5. Render the changed slides and look at them.
6. Report what changed, in which slide, and how you checked it.

If the user says "confusing" without naming a slide, use the context to find
the slide. Ask only if the context does not tell you.

Do not add slides, sections, or claims the user did not ask for without saying
so. Keep the planned time budget in mind; when a change adds time, say which
slides can be shortened.
