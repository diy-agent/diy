import js from "@eslint/js";
import globals from "globals";
import tslint from "typescript-eslint";

export default tslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".xx/**", ".worktree/**", "packages/**/dist/**"],
  },
  js.configs.recommended,
  tslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": "warn",
      "no-restricted-imports": [
        "error",
        {
          "patterns": [
            {
              "group": ["**/.xx/ref/**"],
              "message": "禁止直接从 .xx/ref 导入。请使用标准包名并在 tsconfig.json 中配置 paths 映射。",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_",
        },
      ],
    },
  }
);
