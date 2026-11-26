# Engineering

- Inspect relevant code first. State key assumptions and ask when uncertainty
  affects the solution.
- Make the smallest complete change. Match local style and avoid unrelated
  edits. Keep personal settings and global prompts out of the package.
- Run `npm test` before claiming success. Add regression tests for bugs when
  practical. Check behavior before and after refactors.

## Code readability

- Use clear, consistent names. Name complex conditions and return early when
  it reduces nesting.
- Keep related logic together. Extract helpers when they clarify the caller.
- Name constants with domain meaning. Leave obvious literals inline.
- Use comments to explain constraints the code does not show.
