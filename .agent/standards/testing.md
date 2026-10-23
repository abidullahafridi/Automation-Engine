# Testing Standards

Test behavior and boundaries, not files or coverage theater. Choose the narrowest level that
can prove the contract:

- Unit tests cover deterministic rules, transformations, validators, utilities, and adapters.
- Component tests cover meaningful interaction, state, accessibility, callbacks, or conditional UI.
- Integration tests cover real boundaries such as route-to-handler, server-to-package, repository-to-database, or adapter-to-provider.
- End-to-end tests cover complete user or system journeys and do not replace lower-level tests.

Static markup alone is not a reason for a component test. A rendering test is useful when it
proves an integration contract such as environment-derived configuration reaching a composed
action or a shared package working in its consumer. Do not mock every boundary merely to claim
integration coverage; use dependency fakes for deterministic contract tests, and add live
provider coverage when that external capability becomes required for product behavior.

Run the smallest useful test while implementing, then the repository-owned suite appropriate
to the blast radius. Record deferred live-integration coverage explicitly when an optional
provider is not yet required or available.
