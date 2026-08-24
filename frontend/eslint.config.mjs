// Flat ESLint config for the bot dashboard. Scoped to real defects: unused
// bindings, empty catch blocks and React hook rules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "**/*.mjs", "**/*.cjs", "public/sw.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: {
        window: "readonly", document: "readonly", navigator: "readonly",
        localStorage: "readonly", sessionStorage: "readonly", fetch: "readonly",
        console: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", alert: "readonly",
        confirm: "readonly", location: "readonly", URL: "readonly",
        URLSearchParams: "readonly", Notification: "readonly", atob: "readonly",
        btoa: "readonly", crypto: "readonly", matchMedia: "readonly",
        AbortController: "readonly", RequestInit: "readonly", Response: "readonly",
        HTMLElement: "readonly", HTMLInputElement: "readonly", HTMLSelectElement: "readonly",
        HTMLTextAreaElement: "readonly", HTMLFormElement: "readonly", Event: "readonly",
        PushSubscription: "readonly", ServiceWorkerRegistration: "readonly",
        performance: "readonly", requestAnimationFrame: "readonly",
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-undef": "off",
    },
  },
);
