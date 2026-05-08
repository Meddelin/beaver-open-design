import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Bundle the Beaver UI surface into a single UMD that the iframe preview
// consumes. React/ReactDOM are kept external — the iframe loads them from
// unpkg before this bundle so we don't ship two copies.
//
// Set `BEAVER_DEBUG_BUILD=1` to produce a non-minified build with sourcemaps.
// Useful for diagnosing introspection failures (REMOTE-FIX-QUEUE.md #9):
//   - the spec extractor's "Bundle source context around the first error"
//     diagnostic becomes readable (real identifiers instead of minified
//     one-letter names);
//   - sourcemaps let you trace the failing class declaration back to the
//     original `@beaver-ui/...` or `@tui-react/...` package.
const debugBuild = process.env.BEAVER_DEBUG_BUILD === '1';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Beaver',
      formats: ['umd'],
      fileName: () => 'beaver.umd.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
        assetFileNames: 'beaver[extname]',
      },
    },
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: debugBuild,
    minify: debugBuild ? false : 'esbuild',
  },
});
