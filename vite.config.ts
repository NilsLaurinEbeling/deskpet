import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Tauri sets TAURI_DEV_HOST when developing against a physical device.
const host = process.env['TAURI_DEV_HOST'];

const entry = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Tauri owns the terminal output; don't let Vite wipe it.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    ...(host ? { hmr: { protocol: 'ws' as const, host, port: 1421 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // WebView2 on Windows / WKWebView on macOS.
    target: 'chrome105',
    minify: process.env['TAURI_ENV_DEBUG'] ? false : 'esbuild',
    sourcemap: Boolean(process.env['TAURI_ENV_DEBUG']),
    rollupOptions: {
      input: {
        index: entry('./index.html'),
        overlay: entry('./overlay.html'),
      },
    },
  },
});
