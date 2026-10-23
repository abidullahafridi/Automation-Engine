import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export const createNodeConfig = ({
  files = ["**/*.ts"],
  ignores = ["dist/**"],
  rules = {},
  tsconfigRootDir
}) => tseslint.config(
  { ignores },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files,
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      ...rules
    }
  }
);
