# Layout recipes

Hand-curated TSX recipes for common screen patterns. Unlike everything in
`./components/`, these are NOT auto-generated — they are ground truth that
survives across `beaver:sync` runs.

Each file is a single TSX snippet that shows the canonical Beaver way to
compose one screen pattern. The LLM should copy from here verbatim, not
re-invent the layout.

## Suggested patterns to write

After your first `beaver:sync`, fill in the actual TSX for these recipes
using only components present in `../../components.json`:

- `hero.tsx` — landing hero (`Header` + headline + CTA `Button`)
- `feature-grid.tsx` — three-up feature card layout (`Grid` of `CardLarge`)
- `dashboard-table.tsx` — `Layout` + `Header` + `SideNavigation` + `Subheader`
  + `FilterTable`
- `form-modal.tsx` — `FormModal` + `Form` + `FormObject` + `Button` actions
- `empty-state.tsx` — `EmptyState` with primary `Button` action
- `cta-block.tsx` — full-width call-to-action band
- `comparison-table.tsx` — pricing or feature comparison
- `footer.tsx` — bottom section with `Layout` slot

These mirror the eight layouts shipped with the original `web-prototype`
skill but are rebuilt against Beaver's component vocabulary.
