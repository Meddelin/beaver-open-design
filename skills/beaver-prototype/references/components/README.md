# Per-component specs

> **Auto-generated** by `pnpm beaver:sync`. Do not edit manually.

After sync, this directory will contain one Markdown file per component
present in the manifest. Each file follows the structure:

```markdown
# <ComponentName>

**Package:** `@beaver-ui/<package>` (or `@<inner-ds>/<package>`)
**Tier:** preferred | primitive
**Import:** `import { <ComponentName> } from '<package>';`

## Summary

<one-paragraph description from JSDoc / Storybook docs>

## Props

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| ...  | ...  | ...      | ...     | ...         |

## Examples

```tsx
<example 1 from Storybook>
```

## Notes

(Only for primitives) "Use only when no Beaver alternative fits."
```

The LLM must consult the per-component file before placing a component, so
it has the exact prop shape, allowed enum values, and at least one
canonical example.
