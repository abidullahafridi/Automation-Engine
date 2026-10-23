# Integration Instructions

Treat each external system or vendor library as an integration boundary: databases, queues,
payment providers, email, storage, OAuth providers, caches, external APIs, and model providers.
Application and feature code depend on an explicit integration contract, not directly on a
vendor implementation hidden in `config/`, `lib/`, `utils/`, or constants.

Use ownership to choose placement:

- Reusable technical capability belongs in `packages/<capability>` after reuse is real.
- Server-wide composition belongs in `servers/<runtime>/integrations/<system>`.
- Feature-specific adapters stay with that feature.
- Operational provisioning, telemetry, and platform configuration belong in `enablers/`.

Configuration may provide validated connection inputs, but it must not initialize an external
client. Integration factories receive explicit dependencies and return functional contracts;
do not introduce service locators, mutable global clients, DI containers, or class hierarchies.

The current MongoDB path demonstrates the model: `servers/api/integrations/mongodb` owns the
typed Mongoose adapter, optional API-runtime connection lifecycle, and logging. It remains
server-owned until a second runtime demonstrates real reuse. Future feature repositories will
own persistence operations and depend on this integration boundary rather than Mongoose.
