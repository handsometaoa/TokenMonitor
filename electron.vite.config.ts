import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rendererPage = (page: string): string =>
  fileURLToPath(new URL(`./src/renderer/${page}.html`, import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    worker: {
      format: 'es',
    },
    build: {
      rollupOptions: {
        input: {
          index: rendererPage('index'),
          orb: rendererPage('orb'),
          panel: rendererPage('panel'),
        },
      },
    },
  },
});
