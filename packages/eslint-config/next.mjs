import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export const createNextConfig = ({ tsconfigRootDir }) => defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir }
    }
  },
  globalIgnores([".next/**", ".next*/**", "out/**", "build/**", "next-env.d.ts"])
]);
