# Security Guardrail Extension

## Applies When

- Editing authentication, authorization, sessions, secrets, permissions, roles, audit logs, cryptography, dependency trust, input handling, file uploads, webhooks, payments, or data exposure.

## Rules

- Fail closed. Do not add permissive fallbacks for auth, permission, tenant, or policy checks.
- Preserve existing authorization checks when refactoring.
- Validate and normalize untrusted input at boundaries.
- Do not log secrets, tokens, credentials, PII, payment data, or sensitive request bodies.
- Do not weaken crypto, token expiry, cookie flags, CORS, CSRF, CSP, or rate limits without explicit approval.
- Use constant-time comparison where secret equality checks require it.
- Avoid adding new dependencies for security-sensitive code unless necessary and verified.
- Treat generated code in security-sensitive paths as requiring extra review.

## Verification

- Test allowed and denied cases.
- Run security scans, dependency audits, and secret scans when available.
- For authorization changes, test same-role, lower-role, unauthenticated, and cross-tenant access where applicable.
