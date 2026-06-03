# Database Guardrail Extension

## Applies When

- Editing migrations, schema definitions, models, query builders, repositories, seed data, indexes, or data access logic.
- Changing persistence behavior, transactions, constraints, backfills, retention, or tenancy filters.

## Rules

- Treat migrations and schema changes as public contracts.
- Preserve existing data unless destructive behavior is explicitly requested and reviewed.
- Include rollback, backfill, or compatibility strategy when the repo expects one.
- Keep tenant, ownership, soft-delete, and authorization filters intact.
- Avoid N+1 queries and broad unbounded reads.
- Use transactions when multiple writes must succeed or fail together.
- Do not change generated artifacts manually unless that is the repo convention.

## Verification

- Run migration, model, and data-access tests where available.
- For risky queries, verify indexes, limits, and expected cardinality.
- For multi-tenant systems, test cross-tenant isolation.
