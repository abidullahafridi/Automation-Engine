# Development Standards

Use functional modules by default: pure functions where practical, immutable values,
composition, closures or factories, and explicit dependency objects. Do not require
classes, inheritance, service locators, mutable global registries, or dependency-injection
containers.

Grow architecture progressively. Begin with a feature-owned implementation, introduce a
validation, repository, integration, or domain boundary only when behavior requires it,
and extract to `packages/` only after genuine cross-boundary reuse exists. `prebuilt/`
contains composed reusable solutions, not duplicate package implementations.

Create a category when it expresses meaningful ownership or a credible growth boundary.
About three related files is a useful review prompt, never a mandatory threshold; a
single-file category can be valid and a larger flat set can remain valid. Do not perform
broad directory migrations unless the resulting ownership is clearly more useful than
the disruption.

Do not create empty capability directories. In particular, role folders such as
`routes/`, `controllers/`, `services/`, and `repositories/` are not the default server
feature model. Keep role-named files beside one another while the feature is genuinely
flat. Introduce a role category only when it owns an independently meaningful boundary,
then give it a controlled `index.ts` surface. Use `domain/` only for justified domain
complexity; never create categories as placeholders.

Complete work through `UNDERSTAND -> PLAN -> IMPLEMENT -> VALIDATE -> REVIEW -> RECORD
-> COMPLETE`. Run repository-owned checks and update durable architecture records when a
material contract changes.
