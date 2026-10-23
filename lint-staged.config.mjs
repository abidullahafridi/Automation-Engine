export default {
  "apps/web/**/*.{ts,tsx}": "pnpm --dir apps/web exec eslint --no-warn-ignored",
  "servers/api/**/*.ts": "pnpm --dir servers/api exec eslint --no-warn-ignored",
  "packages/logging/**/*.ts": "pnpm --dir packages/logging exec eslint --no-warn-ignored",
  "packages/types/**/*.ts": "pnpm --dir packages/types exec eslint --no-warn-ignored",
  "packages/ui/**/*.{ts,tsx}": "pnpm --dir packages/ui exec eslint --no-warn-ignored"
};
