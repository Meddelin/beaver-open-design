// Public runtime surface for the iframe preview.
//
// The iframe loads `beaver.umd.js`, which assigns this module's exports to
// `window.Beaver`. The srcdoc import-rewriter then translates user TSX
// imports like:
//
//   import { Button, Drawer } from '@beaver-ui/components';
//   import { colors, spacing } from '@tui-react/design-tokens';
//
// into:
//
//   const { Button, Drawer } = window.Beaver;
//   const { colors, spacing } = window.Beaver.tokens;
//
// To add a Beaver sub-package: add it to `dependencies` in package.json and
// re-export from here. To add inner-DS primitives or tokens: same thing,
// using the actual package names that get pulled into node_modules after
// `pnpm install`.

// ---------------------------------------------------------------------------
// Beaver components — re-exported flat onto `window.Beaver`.
// ---------------------------------------------------------------------------
export * from '@beaver-ui/components';

// Sub-packages enumerated from packages/components/package.json. The barrel
// `@beaver-ui/components` re-exports most of these, but listing them
// explicitly guarantees that anything the barrel happens to skip still ends
// up on window.Beaver. Duplicate exports are deduped by the bundler.
export * from '@beaver-ui/action-bar';
export * from '@beaver-ui/actions-button';
export * from '@beaver-ui/box';
export * from '@beaver-ui/breadcrumbs';
export * from '@beaver-ui/button';
export * from '@beaver-ui/card-large';
export * from '@beaver-ui/chip-group';
export * from '@beaver-ui/drawer';
export * from '@beaver-ui/empty-state';
export * from '@beaver-ui/filter-builder-layout';
export * from '@beaver-ui/filter-table';
export * from '@beaver-ui/flex';
export * from '@beaver-ui/form';
export * from '@beaver-ui/form-modal';
export * from '@beaver-ui/form-object';
export * from '@beaver-ui/grid';
export * from '@beaver-ui/header';
export * from '@beaver-ui/icon-lock';
export * from '@beaver-ui/items-with-more';
export * from '@beaver-ui/layout';
export * from '@beaver-ui/list';
export * from '@beaver-ui/object-card';
export * from '@beaver-ui/pagination';
export * from '@beaver-ui/popover-card';
export * from '@beaver-ui/popover-marker';
export * from '@beaver-ui/search-dropdown';
export * from '@beaver-ui/side-navigation';
export * from '@beaver-ui/split-view';
export * from '@beaver-ui/subheader';
export * from '@beaver-ui/table';

// ---------------------------------------------------------------------------
// Inner-DS components (tier='fallback' in the manifest) — re-exported
// flat onto window.Beaver alongside Beaver's own components. The agent
// picks Beaver-tier components first and only reaches for inner-DS when
// nothing in Beaver fits.
//
// Some inner-DS scopes ship a single barrel package
// (`@<scope>/components`) that re-exports everything; some don't. If
// yours doesn't, append per-package `export * from '@<scope>/<name>'`
// lines below — the bundler dedups duplicate exports, so it's safe to
// list both barrel and individual sub-packages.
//
// If your inner-DS scope is NOT `@tui-react`, search-and-replace it
// across this file and apps/web/src/runtime/beaver-component.ts's
// ALLOWED_IMPORT_PREFIXES.
// ---------------------------------------------------------------------------

export * from '@tui-react/components';

// ---------------------------------------------------------------------------
// Design tokens — published only by the inner-DS, exposed flat under
// `window.Beaver.tokens.<group>` so user TSX can do
// `import { color, spacing } from '@tui-react/design-tokens'` and the
// iframe import-rewriter resolves them via window.Beaver.tokens.
// ---------------------------------------------------------------------------

import * as designTokens from '@tui-react/design-tokens';
export const tokens: Record<string, unknown> = { ...designTokens };
