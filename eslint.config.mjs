import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    // Global ignores
    {
        ignores: [
            "node_modules/**",
            "out/**",
            "release/**",
            "build/**",
            "resources/**",
        ],
    },

    // Base JavaScript recommended rules
    js.configs.recommended,

    // TypeScript recommended rules
    ...tseslint.configs.recommended,

    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/await-thenable": "error",
            "@typescript-eslint/require-await": "error",
        },
    },

    // Node context: electron config, main, preload
    {
        files: [
            "electron.vite.config.ts",
            "src/main/**/*.ts",
            "src/preload/**/*.ts",
            "scripts/**/*.mjs",
        ],
        languageOptions: { globals: { ...globals.node } },
    },

    // Browser context: renderer + its type declarations
    {
        files: ["src/renderer/**/*.{ts,tsx}"],
        languageOptions: { globals: { ...globals.browser } },
    },

    // React hooks + refresh
    {
        files: ["**/*.{ts,tsx}"],
        plugins: {
            "react-hooks": reactHooks,
            "react-refresh": reactRefresh,
        },
        rules: {
            ...reactHooks.configs["recommended-latest"].rules,
            "react-refresh/only-export-components": [
                "warn",
                { allowConstantExport: true },
            ],
        },
    },

    prettier,

    // Enforce braces for all control-flow blocks in the reviewed main-process
    // entry. Placed after prettier so the rule is not disabled by
    // eslint-config-prettier (prettier does not add braces, so the repo
    // convention must be enforced independently). Scoped to this file to avoid
    // flagging pre-existing violations elsewhere.
    {
        files: ["src/main/index.ts"],
        rules: {
            curly: ["error", "all"],
        },
    },
);

