# Backend Guardrail Extension

## Applies When

- Editing server routes, controllers, services, jobs, queues, RPC handlers, API clients, or backend configuration.
- Changing request validation, authorization, logging, error handling, rate limits, retries, caching, or service boundaries.

## Rules

- Follow the existing request lifecycle and error response conventions.
- Keep transport concerns, business logic, persistence, and authorization in their established layers.
- Validate external input at the boundary using the repo's standard validation mechanism.
- Do not add retries, queues, caching, or background work unless the task requires them and failure semantics are clear.
- Preserve API compatibility unless the requested change explicitly breaks it.
- Check all relevant callers when changing handler signatures, response shapes, event payloads, or config keys.
- Prefer existing observability patterns. Do not add noisy logs or swallow exceptions to make errors look handled.

## Verification

- Run relevant backend unit, integration, contract, and migration checks.
- For API changes, verify request validation, authorization failure, success response, and at least one error path.
