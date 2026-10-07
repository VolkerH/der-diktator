import globals from "globals";

const rules = {
  "constructor-super": "error",
  "for-direction": "error",
  "no-async-promise-executor": "error",
  "no-constant-condition": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-duplicate-case": "error",
  "no-ex-assign": "error",
  "no-fallthrough": "error",
  "no-loss-of-precision": "error",
  "no-promise-executor-return": "error",
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  "no-var": "error",
  eqeqeq: ["error", "always"],
  "prefer-const": "error",
};

export default [
  { ignores: [".cache/**", ".git-local/**", "**/.venv/**", "node_modules/**"] },
  { files: ["**/*.js"], languageOptions: { ecmaVersion: "latest" }, rules },
  { files: ["src/phonon_web/static/*.js"], languageOptions: { globals: globals.browser } },
  {
    files: ["src/phonon_web/static/recorder-worklet.js"],
    languageOptions: {
      globals: { AudioWorkletProcessor: "readonly", registerProcessor: "readonly" },
    },
  },
  {
    files: ["eslint.config.js", "frontend/tests/*.js"],
    languageOptions: { globals: globals.node },
  },
];
