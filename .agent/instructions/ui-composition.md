# UI Composition Instructions

The default web foundation is shadcn/ui, Tailwind CSS, and CSS-variable design tokens.
Before creating any UI component, search the configured shadcn registry first. When a suitable
component exists, install it with `pnpm run ui:add <component>` and compose from the generated
source in `packages/ui`; do not copy registry source manually or build a parallel Button, Input,
Dialog, Card, or other named primitive. Use `pnpm run ui:add:all` only when deliberately
reconciling the complete style-compatible official catalog. Both commands run the
repository-pinned shadcn CLI against `packages/ui/components.json`; the architecture policy
records registry entries that are searchable but unavailable for the configured style.

Compose upward in this order:

```text
shadcn primitive -> packages/ui generic component or composition
-> application UI -> feature UI -> page/route
```

A lower layer never imports a higher layer. Generic UI must not know about features or
application-specific components. Pages stay thin: they connect configuration or application
capabilities and compose UI below them; they do not own reusable markup, validation, shared
types, or business behavior.

Create custom UI only when no suitable primitive exists, when a reusable composition of
primitives is needed, or when a meaningful repeated visual pattern exists. Split by semantic
responsibility, not JSX size. Keep component-private prop types local and move only real
cross-boundary contracts to the owning type package.

Prefer theme tokens and reusable components over repeated application-specific utility
conventions. `packages/ui` is the generic UI boundary; applications import its controlled
public API and keep product-specific and feature-specific UI locally owned. Product branding
may extend tokens later but must not introduce a competing design system by default.
