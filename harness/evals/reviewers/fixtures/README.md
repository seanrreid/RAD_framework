# Reviewer eval fixtures

Golden inputs for the live reviewer evals. Each fixture lives at
`<reviewer>/<id>/` and contains:

- `change/`: the files added or modified on the review branch, as a repo-relative
  tree (for example `change/src/pricing.js` becomes `src/pricing.js`).
- `base/` (optional): files that already exist on `main`. None of the current
  fixtures need one.
- `expect.json`: either
  `{ "kind": "positive", "category": "<cat>" | ["<cat>", ...], "minPriority": "HIGH"|"MEDIUM"|"LOW" }`
  or `{ "kind": "negative" }`.

**Judging.** Each fixture is judged over 3 trials, and the majority result wins.
- A **positive** passes when the reviewer reports a finding in the expected
  category, or in any listed category, at `minPriority` or higher.
- A **negative** (clean) fixture passes when the reviewer reports **no HIGH or
  MEDIUM** findings. LOW notes are allowed.

**Design rules.** Each positive plants exactly one defect, and the rest of its change
is clean. Clean fixtures cover the same kinds of code as the positives, so a
reviewer can't pass just by staying quiet about a whole category of code. Every
change file is 40 lines or fewer. Accessibility change files use frontend
extensions only, because the reviewer's Step 1 filters on them.

**Why the co-located tests are `*.spec.js`.** The quality fixtures ship tests
because the project convention says a behavior change must come with a test. A
clean fixture without tests could get a legitimate MEDIUM `convention` finding. The
tests are named `*.spec.js`, not `*.test.js`, so that `node --test` (the harness
`npm test`) does not pick them up with its default glob. Each spec passes when you
run it directly: `node --test <path>`.

## quality-reviewer

| Fixture | Expect | Planted defect, or why it is clean |
|---|---|---|
| `hardcoded-secret` | positive, `security`, HIGH | `src/weather-client.js` embeds a production API key literal (`WEATHER_API_KEY`) and sends it as a bearer token. Input is validated and non-2xx responses throw, so the literal key is the only defect. The checklist says security findings are always HIGH. |
| `swallowed-error` | positive, `error-handling`, MEDIUM | `saveSettings` wraps `writeFile` in `try { … } catch (err) { /* ignore */ }`, so a failed write disappears silently. The checklist rates "Silent catch blocks that swallow errors without logging" as MEDIUM. A reviewer might instead read it as missing file-I/O boundary handling (also MEDIUM) or as an uncaught failure (HIGH); both still pass because they meet `minPriority`. |
| `missing-null-check` | positive, `null-safety`, MEDIUM | `buildShippedEmail` dereferences `customer.email` on the result of `users.find(...)`, which is `undefined` when no user matches. Both arguments are type-checked, so the unguarded `find` result is the only gap. The checklist rates "Dereferencing a value that could be null/undefined without a guard" as MEDIUM. |
| `clean-pure-function` | negative | This is a pure pricing function. Its magic values are named constants, integer and range inputs are validated (zero and negative quantities, fractional prices), and the spec covers the edge cases. |
| `clean-validated-input` | negative | This is a server-side signup handler. It validates the body shape, email format, and name length before the injected persistence port runs, and returns 400 with error messages. Persistence failures reach the caller: the spec shows the rejection propagates. |
| `clean-tested-module` | negative | This is a slug builder with named regex and length constants. It throws a typed error on non-string input and on input that produces no slug, and the spec covers normal input, punctuation, truncation, empty input, and non-string input. |

## accessibility-reviewer

| Fixture | Expect | Planted defect, or why it is clean |
|---|---|---|
| `img-missing-alt` | positive, `text-alternatives`, HIGH | In `ProductCard.jsx`, the informative product `<img>` has no `alt` (WCAG 1.1.1). The card also has a labelled `<article>` and a descriptive `<button>`. The checklist rates "Images without `alt` text" as HIGH. |
| `unlabeled-input` | positive, `["input-assistance", "adaptable"]`, **MEDIUM** | In `NewsletterForm.jsx`, the email `<input>` has only a `placeholder` and no label, `aria-label`, or `aria-labelledby`. The name input next to it is correctly labelled. |
| `div-click-no-keyboard` | positive, `keyboard-accessible`, HIGH | In `PlanPicker.jsx`, each plan is a `<div onClick>` with no `role`, `tabIndex`, or key handler, so keyboard users cannot select a plan (WCAG 2.1.1). The checklist rates this as HIGH. A reviewer might also report `compatible` (4.1.2); that doesn't affect the result, since the check only needs `keyboard-accessible`. |
| `clean-labeled-form` | negative | This is a full HTML page with `lang`, a `<title>`, `<main>`, and an `<h1>`. Every input has a `<label for>`. Required fields say "(required)" in the visible label and set `required` and `aria-required`, the email field has a hint linked through `aria-describedby`, and the submit button is descriptive ("Create account"). |
| `clean-alt-images` | negative | Informative portraits and the map image have descriptive `alt` text, and the decorative divider has `alt=""`. The section has a heading and uses `<figure>` with `<figcaption>`. |
| `clean-button-controls` | negative | Every control is a native `<button type="button">` with visible, specific text. The icon-only delete button has an `aria-label`, and its SVG is `aria-hidden` and not focusable. There is intentionally no `role="toolbar"`, which would imply an arrow-key roving-focus pattern, and no disabled-while-saving state, which would drop focus. Either could draw a legitimate HIGH finding. |

## minPriority judgment calls

- **`unlabeled-input`: MEDIUM, not HIGH.** The reviewer's checklist rates
  "Form inputs not associated with labels" as HIGH under *Adaptable (1.3)*. But a
  placeholder-only input is also a common *Input assistance (3.3)* finding, and
  the related 3.3 items are MEDIUM. Because the checklist is unclear about which
  category and priority apply, both categories are accepted and the bar is one
  level lower. A HIGH `adaptable` finding still passes.
- **`swallowed-error`: MEDIUM.** This matches the checklist's own rating for
  silent catch blocks. A HIGH rating passes as well.
- **`missing-null-check`: MEDIUM.** This matches the checklist's own rating. The
  lower "optional chaining absent" (LOW) item does not apply here, because no
  guard was written at all.
