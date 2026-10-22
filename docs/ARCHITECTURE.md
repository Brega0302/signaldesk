# Architecture and tradeoffs

## Scope

One workspace, one Node process, one SQLite file. This is an incident coordination tool, not a monitoring agent. Health derives from incident records; it does not ping external services. Seed timestamps are relative to the first run.

## Data model

- users: unique email, password hash, constrained role.
- sessions: SHA-256 of a random 256-bit token, user FK, expiry.
- services: service catalog and owning team.
- incidents: severity, status, service FK, optional assignee, timestamps, integer version.
- events: incident FK, actor FK, kind, text, timestamp.
- schema_migrations: initial schema version marker. Further migrations must be added explicitly; this is not a complete migration runner.

Foreign keys and CHECK constraints enforce basic database invariants. All external values use bound SQL parameters. Search escapes LIKE wildcard characters. The main listing has a fixed 10-row page size and validated upper bound on page number.

## Request path

1. Request ID and security headers.
2. Cross-site write and content-type checks.
3. Body parsing with a 32 KB limit.
4. Session lookup and expiry check.
5. Role authorization.
6. Zod validation and business rules.
7. Transaction for incident creation/updates and related audit events.
8. JSON response or error envelope.

The error response includes a request ID; unexpected server errors are logged with that ID, method and path. Request bodies and credentials are not logged.

## Authentication

scrypt hashes passwords with independent random salts; timingSafeEqual compares digests. Unknown usernames run against a dummy hash to reduce obvious timing differences. Tokens never appear in localStorage. The database stores token hashes instead of bearer tokens.

Cookies are SameSite=Strict and HttpOnly. Secure is configurable because HTTP localhost development cannot use a Secure cookie. Login rotates the old session for that browser, logout deletes it, and sessions expire after eight hours. Login has an IP-based in-memory limit.

This is not enterprise identity management. There is no password reset, MFA, account provisioning, per-user lockout, or distributed throttling. Behind a proxy, configure trusted proxy behavior deliberately; never blindly trust forwarded IP headers.

## CSRF boundary

The API accepts JSON for writes and rejects cross-site Fetch Metadata or mismatched Origin hosts. There is no cross-origin CORS support. This fits the same-origin deployment model. A deployment with separate UI/API domains needs a redesigned, explicit CSRF and origin policy.

## Concurrency and atomicity

An update includes the version observed by the client. Inside BEGIN IMMEDIATE, the server reads the row, compares versions, validates changes, updates version+1 and writes events. Commit succeeds as one unit. Any error rolls back.

Example: A and B both read version 3. A updates and commits version 4. B submits version 3; the API returns 409. The UI reloads the latest record and displays the conflict instead of silently retrying.

No-op updates currently increment version without an audit event. This is safe but could be optimized. Discussion comments append independently and do not modify the incident version.

## Lifecycle

Open -> Investigating -> Monitoring -> Resolved.
Monitoring -> Investigating allows a failed mitigation.
Resolved -> Open reopens an incident and clears resolved_at.
Status changes outside that graph receive 422.

Assignment is restricted to admin/responder accounts. Client-supplied actor identities are rejected; the actor comes from the authenticated session.

## Metrics

MTTR is mean elapsed minutes between created_at and resolved_at for currently resolved incidents, not a percentage SLA and not a rolling-window availability measurement. Reopened incidents drop out until resolved again; their eventual duration includes earlier attempts.

Service health precedence is outage if any unresolved critical incident exists, degraded if any other unresolved incident exists, otherwise operational. This is a derived coordination indicator, not measured uptime.

Charts use UTC calendar days. Displayed incident times follow the browser locale/timezone.

## Deployment and next steps

- One instance with a persistent disk, HTTPS reverse proxy and backups.
- Backup using a SQLite-aware online backup procedure, not an unsafe copy of a live WAL database file.
- Before real use, replace demo identities, add account administration, monitoring, retention policies, migrations and security review.
- For scale: PostgreSQL, explicit transaction isolation, shared rate-limit storage, centralized logs, backups and restore drills.
- For multi-tenancy: tenant IDs, composite constraints and authorization scoping on every query; adding a selector to the UI is insufficient.
- For notifications: transactional outbox and idempotent worker, not email directly inside the request transaction.
- Keep seeded demo data distinct from real operational evidence.
- Frontend is deliberately compact for learning. Extract API hooks, feature folders and presentational components as it grows.


## Password hashing tradeoff

This small demo uses synchronous scrypt. Its CPU cost blocks the Node event loop during login. A production authentication endpoint should use asynchronous scrypt or a worker pool and tighter resource controls to avoid making the API unresponsive under login load. The IP limiter reduces repeated attempts but does not solve distributed abuse.
