import { createReactConfig } from "@workspace/eslint-config/react";

export default createReactConfig({
  tsconfigRootDir: import.meta.dirname,
  disableTypeCheckingFor: ["src/primitives/**/*.tsx", "src/hooks/**/*.tsx"]
});
