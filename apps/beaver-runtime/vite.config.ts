import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Bundle the Beaver UI surface into a single UMD that the iframe preview
// consumes. React/ReactDOM are kept external — the iframe loads them from
// unpkg before this bundle so we don't ship two copies.
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
    sourcemap: false,
  },
});
