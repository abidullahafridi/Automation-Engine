"# code_base_squid" 
"# nutshyll" 

## Local MongoDB Replica Set

Automation outbox/ingest requires MongoDB transaction support. Standalone MongoDB is
unsupported. The local fixture starts a single-node `rs0` replica set and its healthcheck
initiates the set:

```powershell
docker compose up -d --wait mongodb
$env:MONGO_URI = "mongodb://127.0.0.1:27017/automation_test?replicaSet=rs0"
$env:ALLOW_NON_PROD = "yes"
node scripts/verify-mongo-transactions.mjs
Remove-Item Env:MONGO_URI
Remove-Item Env:ALLOW_NON_PROD
docker compose down
```

The verifier writes a sanitized run record under `docs/architecture/evidence/`. A successful
local run proves only the local replica-set mechanism; it is **not** verification of the
actual production target. The production outbox/ingest feature flag must remain off until
every verifier check passes against the actual target and that evidence is recorded.

The proposed CI transaction-probe job is gated on the repository variable
`MONGO_REPLICA_SET_CI_APPROVED=true`; infrastructure owner approval is pending. Do not set
that variable until the CI replica-set environment is approved.
