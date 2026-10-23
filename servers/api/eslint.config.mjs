import { createNodeConfig } from "@workspace/eslint-config/node";

export default createNodeConfig({
  tsconfigRootDir: import.meta.dirname,
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  }
});
