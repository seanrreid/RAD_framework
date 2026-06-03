# Testing Guardrail Extension

## Applies When

- Adding, changing, deleting, or repairing tests, fixtures, test helpers, mocks, snapshots, factories, or CI test commands.

## Rules

- Test behavior, not implementation details, unless the implementation is the contract.
- Keep tests deterministic. Avoid real network, time, randomness, ordering, or external services unless explicitly part of the test.
- Prefer existing test helpers, factories, fixtures, and assertion style.
- Do not weaken or delete tests to make a change pass without explaining why the old expectation was wrong.
- Keep mocks faithful to the real contract. Do not mock away the behavior being tested.
- Cover regression cases for bug fixes.
- Avoid broad snapshot updates unless visual or structural output intentionally changed.

## Verification

- Run the narrowest relevant test first, then the broader suite if risk warrants it.
- Report exact test commands run and any skipped suites.
