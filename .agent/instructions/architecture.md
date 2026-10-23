# Architecture Instructions

Treat the repository as the workspace. Workspace units live directly under configured
roots such as `apps/web`, `servers/api`, `packages/ui`, or a custom name justified by the
system. Never require or invent a shared project-name directory.

Before architecture changes, identify the affected plane and owner, read the narrowest
relevant knowledge chain, and choose the smallest structure that solves the current
problem. Keep application work out of the control plane unless control-plane work is
explicitly authorized.

Organize business behavior by feature. A server feature starts with only the files it
needs. Supported role names are `<feature>.route.ts`, `<feature>.controller.ts`,
`<feature>.service.ts`, `<feature>.repository.ts`, `<feature>.validation.ts`,
`<feature>.model.ts`, and `<feature>.integration.ts`. These files are all optional.
Introduce `domain/` only for meaningful domain behavior, using files such as
`<feature>.entity.ts`, `<feature>.rules.ts`, and `<feature>.policy.ts`.

Server features live at `servers/<runtime>/features/<feature>/` and expose composition
only through the feature root `index.ts`. Keep a small feature flat until responsibilities
become independently meaningful. When route, controller, service, validation, repository,
model, integration, or test ownership justifies a category, place that role under its
named directory and expose its intended surface through that directory's `index.ts`.
Never create empty role directories.

HTTP features follow `route -> controller -> service -> domain/repository/integration`
only as far as current behavior requires. Routes define endpoints and compose explicit
feature dependencies; controllers translate HTTP requests and responses; services own
application operations. Use functional factories and immutable dependency contracts, not
classes, containers, service locators, or mutable registries. Bootstrap may provide
dependencies, call the root feature factory, and register its router, but it must not own
feature response construction or behavior.

Keep feature-specific contracts close to the layer that owns them, promote only genuine
cross-workspace contracts to shared packages, and keep runtime validation in the owning
feature rather than `config/`. Reuse categorized API constants for shared HTTP statuses
and errors while leaving one-off local values local. Test behavior at the narrowest useful
boundary: services and controllers with deterministic dependencies, routes through HTTP,
and repositories or integrations only when those boundaries exist. Consumers outside a
feature must not deep-import its internal layers.

Preserve dependency direction: delivery and UI call application operations; application
services coordinate domain rules and explicit repository/integration boundaries;
infrastructure implements technical concerns. Domain code must not depend on delivery,
persistence models, infrastructure frameworks, or vendors.

Architecture grows from simple to modular, bounded, scalable, distributed, and platform
forms only as concrete needs appear. Apply the ownership test before extracting: shared
implementation belongs in `packages/`; feature behavior stays with its feature;
application/runtime composition stays in its app or server; operational capability belongs
in `enablers/`. See `ui-composition.md` and `integrations.md` for those dependency models,
and `../standards/types-validation.md` for contract ownership.
