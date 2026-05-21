import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    rules: {
      // Underscore-prefix convention for intentionally-unused identifiers.
      // Aligns with TypeScript's `noUnusedLocals` skip-on-underscore behavior
      // and the Playwright/Vitest convention of `({ page: _page })` to opt
      // out of destructured-arg coverage without renaming the destructured
      // key. Without this override, the recommended preset bans ALL unused
      // — including intentionally-discarded args in test fixtures, hook
      // unused destructure positions, and rest-spread placeholders.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // ─────────────────────────────────────────────────────────────────
      // 2026-05-21 LINT RE-PROMOTE: PR #48 closed the 91 underlying
      // react-hooks v7 + no-explicit-any + only-export-components
      // violations. The rules below are now back at `error` so any
      // future regression fails CI loudly. Only `incompatible-library`
      // stays at `warn` — 2 residual violations remain there; the
      // spawned cleanup task will close them and re-promote.
      // ─────────────────────────────────────────────────────────────────
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/static-components': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/component-hook-factories': 'error',
      'react-hooks/error-boundaries': 'error',
      'react-hooks/gating': 'error',
      'react-hooks/globals': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/unsupported-syntax': 'error',
      'react-hooks/use-memo': 'error',
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'react-refresh/only-export-components': 'error',

      // 2026-05-18 LINT FIX (cont.): allow empty catch blocks. The codebase
      // uses `try { ... } catch {}` idiomatically for "best-effort" calls
      // (localStorage operations that may throw on quota / private-browsing,
      // JSON parses on untrusted external data, optional fetch fallbacks).
      // Each is intentional — the failure is structurally absorbed by the
      // default branch. `allowEmptyCatch: true` matches the standard ESLint
      // recipe for this pattern.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
