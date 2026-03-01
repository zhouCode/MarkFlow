import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  return {
    plugins: [react()],
    root: '.',
    // Packaged Electron loads renderer via file://, so production build must use relative asset paths.
    base: command === 'serve' ? '/' : './',
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true
    },
    server: {
      port: 5173,
      strictPort: true
    }
  };
});
