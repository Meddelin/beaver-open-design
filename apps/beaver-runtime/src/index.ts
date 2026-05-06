// Public runtime surface for the iframe preview.
//
// The iframe loads `beaver.umd.js`, which assigns this module's exports to
// `window.Beaver`. The srcdoc import-rewriter then translates user TSX
// imports like:
//
//   import { Button, Drawer } from '@beaver-ui/components';
//   import { colors, spacing } from '@<inner-ds>/design-tokens';
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
// Inner-DS primitives + design tokens.
//
// FILL IN after the first `pnpm install` — read
// `node_modules/@beaver-ui/components/package.json` to discover the actual
// scope name of the inner DS Beaver consumes (it shows up in the resolved
// dependency graph). Replace `<inner-ds>` below and uncomment.
// ---------------------------------------------------------------------------

// export * from '@<inner-ds>/components';

// import * as colors from '@<inner-ds>/design-tokens/colors';
// import * as spacing from '@<inner-ds>/design-tokens/spacing';
// import * as typography from '@<inner-ds>/design-tokens/typography';
// import * as animation from '@<inner-ds>/design-tokens/animation';

// export const tokens = { colors, spacing, typography, animation };

// Until the inner-DS scope is wired in, we expose an empty tokens object so
// the iframe rewriter has something to destructure from. The build will
// fail loudly when the LLM emits a tokens import and finds nothing — that
// is the desired signal to finish wiring this file.
export const tokens: Record<string, Record<string, unknown>> = {};
