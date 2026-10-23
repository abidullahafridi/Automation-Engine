# Runtime environment configuration

This repository validates runtime configuration before either application starts. Examples
contain placeholders only; values for a real environment are supplied by that environment's
deployment configuration and secret manager, never committed to the repository.

## API (`servers/api`)

| Variable | Environments | Validation / purpose | Secret |
|---|---|---|---|
| `NODE_ENV` | local, staging, production | `development`, `test`, or `production` | No |
| `API_HOST` | local, staging, production | Non-empty bind host | No |
| `API_PORT` | local, staging, production | Integer from 1 through 65535 | No |
| `API_REQUEST_TIMEOUT_MS` | local, staging, production | Integer timeout from 1000 through 120000 milliseconds | No |
| `WEB_ORIGIN` | local, staging, production | Absolute URL permitted by CORS | No |
| `LOG_LEVEL` | local, staging, production | One of the supported logger levels | No |
| `AUTOMATION_API_ENABLED` | local, staging, production | Optional `true` or `false`; defaults to disabled | No |
| `MONGODB_URI` | production required; local/staging when persistence is used | Non-empty MongoDB connection URI | Yes |

The API exits before opening a listener when validation fails. Its error reports only the
invalid variable names and validation rules; it never includes the supplied value. In
production `MONGODB_URI` is mandatory. A secret manager must inject it into the process
environment; do not place a production URI in `.env`, CI output, logs, or build arguments.

`AUTOMATION_API_ENABLED=true` is not a substitute for configured platform auth, policy, and
repository adapters. Production platform authentication must be provided by the platform
integration and is not enabled by this flag alone.

## Web (`apps/web`)

| Variable | Environments | Validation / purpose | Secret |
|---|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | local, staging, production | Absolute Automation API URL | No |

`NEXT_PUBLIC_*` values are embedded in browser builds. They must never contain credentials,
tokens, connection strings, or any other secret.

## Environment separation

- Local: use copied `.env` files with local-only values. They remain ignored by Git.
- Staging: use a distinct staging secret store and database identity.
- Production: use a distinct production secret store, least-privilege database identity, and
  deployment-time injection. Do not reuse staging credentials.

Before deployment, run `pnpm run lint`, `pnpm run typecheck`, and the relevant test suite.
Configuration validation is exercised by `servers/api/tests/environment.test.ts` and
`apps/web/tests/environment.test.ts`.
