import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.jsx',       // Your React entry point
      name: 'ChatWidget',
      fileName: () => 'chat-widget.js',
      formats: ['iife'],            // Immediately Invoked Function Expression bundle for browser
    },
    outDir: 'extensions/chat-widget/assets',  // Output folder for your extension assets
    emptyOutDir: false,             // Do not clear assets folder on build (optional)
  },
  optimizeDeps: {
    exclude: ['react', 'react-dom'],  // Exclude react from the bundle if loading via CDN
  },
  esbuild: {
    jsxInject: `import React from 'react'`,  // Automatically import React in JSX files
  }
});
