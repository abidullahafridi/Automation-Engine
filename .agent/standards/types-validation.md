# Type And Validation Standards

Keep TypeScript strict across every workspace unit. Explicit `any`, weak boundary parameters,
and unchecked external values are prohibited. Narrow `unknown` deliberately and define
interfaces or type aliases only where a meaningful public, dependency, repository, integration,
service, or shared-data contract exists.

Apply this ownership test:

```text
shared across workspace boundaries -> packages/types/<category>
feature contract                   -> feature/types
application/runtime contract       -> owning app or server types
component or implementation private -> keep local
```

`packages/types` is categorized by real contract area and must not become a miscellaneous
global type bucket. Do not duplicate a public contract in web and server, and do not globalize
unrelated local shapes merely because their names look similar.

Runtime validation follows the same ownership rule. Shared schemas belong in a categorized
`packages/validation` package only when more than one boundary actually consumes them;
feature and runtime-specific schemas remain with their owner. Keep schemas in `validation/`,
validated access in `config/`, fixed values in `constants/`, and environment values in env
files/process input. When a shared schema owns a shared contract, infer or directly associate
the TypeScript type with the schema instead of maintaining parallel definitions.
