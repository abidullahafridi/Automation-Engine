import { createNodeConfig } from "@workspace/eslint-config/node";

export default createNodeConfig({
  tsconfigRootDir: import.meta.dirname,
  files: ["src/**/*.ts"],
  rules: { "@typescript-eslint/consistent-type-exports": "error" }
});
