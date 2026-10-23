# Protected Append-Only Audit Records (AE-T-042.2)

**Task:** AE-T-042.2, Implement protected append-oriented audit records
**Story:** AE-US-042, Trace a run from event through each action
**Requirements:** FR-015, FR-024, NFR-006, NFR-014, BR-009; spec section 13.8, INV-08
**Owner:** Abid Ullah
- **Status (2026-10-17): Implemented for application-layer scope; verification pending.** Append-only `AuditLog` (insert/find only, no TTL), redacted scalar `details`, per-record `contentHash`, deterministic lifecycle record ids, `createLifecycleAuditPort` and execution-denial adapter are covered by TC-0425–TC-0427 (in-memory, source-scan guard, and Mongo test with `MONGO_URI`). Remaining: apply and verify the DB role (find+insert only), retention approval (~400 days is a proposal), independent security review, permissioned audit read API, and composition-root wiring.
## Schema (`audit.record.ts`)

| Field | Notes |
|---|---|
| `recordId` | Unique per workspace. Deterministic for lifecycle events, so retries are idempotent. |
| `workspaceId` | Always taken from the trusted scope, never from the request. |
| `actor` | `{ type: user, system or automation; id }` |
| `action` | automation.enable/pause/resume/disable/archive, execution.denied, run.retry, run.replay, quota.override, flag.change |
| `target` | `{ type: automation, run, workspace or flag; id }` |
| `outcome` | succeeded, denied or failed. A denied action is never recorded as success. |
| `occurredAt`, `correlationId` | ISO instant and correlation id. |
| `details` | Scalar values only, at most 20 keys, key pattern `^[A-Za-z][A-Za-z0-9_]{0,39}$`. |
| `contentHash` | sha256 over all other fields. |

## Redaction

- Sensitive keys (token, secret, password, apikey, authorization, cookie, credential, privatekey) become `[REDACTED]`. `fencingToken` is safe.
- String values are scrubbed (Bearer tokens, JWTs, URL passwords, `key=value`) and capped at 512 characters.
- Nested objects and arrays become `[UNSUPPORTED]`. Non-finite numbers are rejected.
- Callers pass codes, not free text or payloads. Scrubbing cannot recognize a bare secret with no marker.

## How prior records are protected

1. **Type surface:** `AuditLog` exposes only `append` and `list`.
2. **Repository code:** `audit.repository.ts` uses `insertOne` and `find` only. No update, replace, delete, drop or TTL. `audit.append-only.test.ts` scans the file and fails if that changes.
3. **Conflict rule:** same `recordId` with different content returns `conflict` and changes nothing. Same content returns `idempotent`.
4. **Integrity:** `contentHash` is verified before storage, and `verifyAuditRecord` detects modified copies.
5. **Frozen results:** records returned from the log are deeply frozen.
6. **Database role (operational, NOT verified here).** Proposed, to be applied and tested by the operating owner:

```javascript
db.createRole({
  role: "automationAuditAppender",
  privileges: [{ resource: { db: "<db>", collection: "automation_audit" }, actions: ["find", "insert"] }],
  roles: []
})
```

With that role the runtime cannot create indexes. Create them with a migration role, then use `createMongoAuditLog({ ..., ensureIndexes: false })`.

## Wiring

- `createLifecycleAuditPort({ recorder })` is a drop-in `AuditPort` for `transitionAutomationLifecycleWithAudit`. It throws if the record cannot be stored.
- `executionDenialAuditRequest(...)` builds the record for `OWNER_ACCESS_LOST` and similar denials from `execution.context.ts`.

## Retention and access

- No TTL. Operational expiry must never remove audit records.
- Retention period is **pending owner approval**. The ~400 days in the backlog is only a proposal.
- Reading audit records is a port (`AuditLog.list`). A permissioned read API (for example `automation.audit.read`) is not part of this task.

## Tests

TC-0425 lifecycle record, TC-0426 denied outcome and redaction, TC-0427 no mutation, in `audit.test.ts` and `audit.append-only.test.ts`. Real Mongo behavior in `audit.mongo.test.ts` (needs `MONGO_URI`).

## Not covered (explicit)

- The database role above is not applied or verified.
- Retention approval, independent security review and legal-hold handling.
- Hash chaining across records (spec marks it optional). Per-record hashes detect edits, not deletion of a whole record.
- Call sites: switching the composition root from the in-memory `AuditPort` to `createLifecycleAuditPort`, and recording execution denials, replay and quota overrides from their services.
- A permissioned audit read API.