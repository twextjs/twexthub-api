# AGENT.md

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Say the thing, not the importance of the thing](#say-the-thing-not-the-importance-of-the-thing)
- [Don't oversell notability or coverage](#dont-oversell-notability-or-coverage)
- [Avoid stock transition and hedge words](#avoid-stock-transition-and-hedge-words)
- [Skip the canned structure](#skip-the-canned-structure)
- [Prefer plain constructions over inflated ones](#prefer-plain-constructions-over-inflated-ones)
- [Don't manufacture false contrast](#dont-manufacture-false-contrast)
- [Formatting](#formatting)
- [Specificity over polish](#specificity-over-polish)
- [Attribution](#attribution)
- [Before submitting](#before-submitting)
- [Writing code that doesn't read as AI-generated](#writing-code-that-doesnt-read-as-ai-generated)
  - [Comments](#comments)
  - [Docstrings](#docstrings)
  - [Naming and structure](#naming-and-structure)
  - [Before submitting](#before-submitting-1)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

---

Guidelines for agents writing documentation in this repo. Goal: read like a developer wrote it after using the thing, not like it was generated to describe the thing. This section covers docs (READMEs, guides, changelogs, comments). Other sections may follow for code style, commits, etc.

## Say the thing, not the importance of the thing

Don't narrate significance. State what something does or how to use it.

- Bad: "This module plays a crucial role in the authentication pipeline,
  ensuring robust and secure access."
- Good: "This module validates JWTs and rejects expired ones."

Cut sentences whose only job is to tell the reader something matters, represents a shift, or reflects a broader pattern. If a fact needs that kind of framing to seem interesting, either make it concrete or drop it.

## Don't oversell notability or coverage

Skip lines that just assert legitimacy or attention: "widely used," "actively maintained," "growing community," "gaining traction." If a claim like that is true and relevant, back it with a number (stars, downloads, version count) or leave it out.

## Avoid stock transition and hedge words

Words that show up constantly in generated text and rarely in text written by someone who actually did the work: `delve`, `boasts`, `crucial`, `pivotal`, `underscore`, `showcase`, `robust`, `seamless`, `leverage`, `streamline`, `foster`, `enhance` (as a filler verb), `landscape` (as an abstract noun), `tapestry`, `testament to`, `plays a vital role`.

Avoid stacking "Additionally," / "Furthermore," / "Moreover," at the start of consecutive sentences or bullets — vary structure or cut the transition entirely.

## Skip the canned structure

- No "Conclusion" or "Summary" section that just restates what was already
  said, unless the doc is long enough to genuinely need a recap.
- No "Challenges" or "Future Outlook" section that follows the shape
  "Despite X, faces several challenges... nonetheless positioned to..."
  unless there's something specific to say.
- No rule-of-three padding ("fast, reliable, and scalable") when one or
  two of those are the actual claims and the third is filler.
- Section headers should describe content, not perform enthusiasm
  ("Getting Started" not "Unlock the Power of X").

## Prefer plain constructions over inflated ones

- "X is a Y that does Z" over "X serves as a Y, enabling Z."
- "has" over "boasts," "offers," "features" (when those are just standing
  in for "has").
- "used" over "utilized," "tried" over "attempted," "moved" over
  "relocated." Plain verbs, not their fancier synonyms.
- Simple `is`/`has` sentences are fine. Don't dress them up.

## Don't manufacture false contrast

Skip "not just X, but Y" and "it's not X — it's Y" constructions unless the contrast is real and the reader actually expected X. These read as a rhetorical tic when the "not X" part was never a live possibility.

## Formatting

- Don't bold every key term in a paragraph. Bold sparingly, for things a
  skimming reader genuinely needs to catch.
- Avoid emoji as bullet decoration or section markers.
- Em dashes are fine when used the way a comma or parenthesis would be —
  not as a tic for punching up every other sentence.
- Lists should hold genuinely parallel, separate items — not a restatement
  of the same idea three ways to look thorough.
- Skip "Key Takeaways" boxes and inline-bold-header bullet lists
  (`- **Term**: description`) unless the content is truly a reference table
  that benefits from scanning.

## Specificity over polish

If a detail is unusual, technical, or specific, keep it — don't smooth it into a generic statement to sound more "encyclopedic." Vague positive language is easier to write than specific accurate language, which is exactly why it's a tell. Prefer the sharp, checkable detail over the smooth, unfalsifiable one.

## Attribution

Don't attribute claims to vague authorities ("developers have noted...", "users report...") to make a point sound backed by consensus. If you can't cite a specific source or you're stating your own assessment, just state it plainly, or mark it as an assumption/opinion.

## Before submitting

Read it back and ask: would a maintainer who just wrote this by hand, half-tired, in their own voice, actually phrase it this way? If a sentence only exists to sound thorough or reassuring rather than to convey information, cut it.

## Writing code that doesn't read as AI-generated

Detectors (and reviewers) key on surface polish more than on logic. Match the surrounding file's existing style and conventions — comment density, docstring presence, whitespace, import ordering — rather than defaulting to a generic style. Write less scaffolding, not different scaffolding.

### Comments

- Don't add a comment that just restates the line under it
  (`# increment the counter` above `count += 1`). If a comment doesn't add
  information the code doesn't already convey, cut it.
- Don't narrate steps for their own sake ("# Step 1: validate input",
  "# Step 2: process the data", "# Placeholder for actual implementation").
  Real code has comments where the _why_ isn't obvious, not one per line or
  one per logical block by default.
- Don't leave process/status comments in finished code ("# Code to remove
  the machine with the given ID from the model", written as commentary
  about the task rather than the implementation). If the comment describes
  what you were asked to do rather than what the code does, delete it and
  write the actual body.

### Docstrings

- Don't add a full Args/Returns/Raises docstring to every function
  regardless of size. A one-line private helper doesn't need the same
  treatment as a public API entry point. Match the level of documentation
  already used in the surrounding file.
- Don't restate the signature in prose ("Adds x and y and returns the
  sum" above `def add(x, y):`). If the docstring doesn't say anything the
  signature doesn't, skip it or say something that does add information
  (an edge case, a unit, a precondition).

### Naming and structure

- Use naming conventions consistent with the rest of the codebase, not
  generic textbook names (`result`, `temp`, `data`, `process_data`) picked
  in isolation. Look at what's already there before naming new things.
  Match the existing formatting style (quote style, indentation, brace/no
  brace conventions) rather than defaulting to a generic house style.
- Don't add redundant or unjustified defensive scaffolding — extra
  try/except blocks, input validation, logging — that the surrounding code
  doesn't otherwise use for similar functions. Keep the controls the input
  boundary, threat model, or operational contract actually requires. Match
  the risk posture of the codebase, not a generic "production-ready"
  template. Real code under-handles some edge cases; code that handles all
  of them uniformly, everywhere, by default, reads as generated.
- Prefer the direct implementation over one that performs
  thoroughness — don't add unrequested type hints, unused imports "for
  completeness," or extra abstraction layers (a class where a function
  would do) unless the codebase's existing patterns call for them.
- Idiosyncrasy is fine. Real codebases are inconsistent — different
  authors, different eras. Don't smooth every function into the same
  shape; match whatever's already near the code you're changing.

### Before submitting

Diff what you wrote against the surrounding file. If your new code is more commented, more defensively coded, or more uniformly formatted than everything around it, that mismatch is the tell — bring it down to the file's actual baseline rather than up to a generic ideal.
