// Vite build for Omnibus (replaced Create React App 2026-11-03).
// Output keeps CRA's layout so nothing else changes: build/ with hashed files
// under build/static/ (server.js serves /static with a one-year cache) and an
// asset-manifest.json in CRA's shape (public/sw.js pre-caches the files it lists).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function assetManifest() {
  return {
    name: 'omnibus-asset-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = {}, entrypoints = [];
      for (const [fileName, out] of Object.entries(bundle)) {
        if (!/\.(js|css)$/.test(fileName)) continue;
        files[fileName.replace(/^static\//, '')] = `/${fileName}`;
        if (out.type === 'chunk' && out.isEntry) entrypoints.push(fileName, ...((out.viteMetadata && [...out.viteMetadata.importedCss]) || []));
      }
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify({ files, entrypoints }, null, 2) });
    },
  };
}

export default defineConfig({
  plugins: [react(), assetManifest()],
  build: {
    outDir: 'build',
    assetsDir: 'static',
    emptyOutDir: true,
    // Browsers from about 2020 on (Safari 14+); CRA's list allowed older ones.
    target: ['es2020', 'safari14'],
    chunkSizeWarningLimit: 2500,
  },
  server: { port: 3000, proxy: { '/api': 'http://localhost:9810' } },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
