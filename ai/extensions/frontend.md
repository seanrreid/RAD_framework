# Frontend Guardrail Extension

## Applies When

- Editing UI components, CSS, routes, forms, client-side state, browser behavior, visual design, accessibility, or frontend tests.

## Rules

- Reuse the existing design system, tokens, layout primitives, icons, state patterns, and component conventions.
- Do not introduce a new styling approach unless the repo already uses it or the task requires it.
- Preserve keyboard access, focus management, semantic HTML, labels, and accessible names.
- Handle loading, empty, error, disabled, optimistic, and long-content states when the changed UI can encounter them.
- Keep text within containers across supported viewport sizes.
- Avoid layout shifts from hover states, dynamic labels, async data, or validation messages.
- Do not bury important user actions behind unfamiliar controls without clear affordance.

## Verification

- Run relevant frontend checks: type check, lint, unit tests, component tests, visual tests, or build.
- Verify changed screens at mobile and desktop widths.
- For interactive changes, verify keyboard, pointer, and error-state behavior.
