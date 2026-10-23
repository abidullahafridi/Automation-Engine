import { createNodeConfig } from "@workspace/eslint-config/node";

export default createNodeConfig({ tsconfigRootDir: import.meta.dirname });
