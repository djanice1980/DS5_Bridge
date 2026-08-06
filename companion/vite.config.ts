import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      // The tester is a second window with its own entry, not a route inside the main app: it
      // has to be openable and closable without disturbing the main window's state.
      input: {
        index: path.resolve(__dirname, 'index.html'),
        tester: path.resolve(__dirname, 'tester.html')
      }
    }
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname), path.resolve(__dirname, '..')]
    }
  }
});
