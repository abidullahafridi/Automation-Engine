import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export const createReactConfig = ({
  files = ["**/*.{ts,tsx}"],
  ignores = ["dist/**"],
  disableTypeCheckingFor = [],
  rules = {},
  tsconfigRootDir
}) => tseslint.config(
  { ignores },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      ...rules
    }
  },
  ...(disableTypeCheckingFor.length === 0 ? [] : [{
    ...tseslint.configs.disableTypeChecked,
    files: disableTypeCheckingFor,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-explicit-any": "error"
    }
  }])
);
