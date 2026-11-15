import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
        'use-sync-external-store/shim/with-selector.js': path.resolve(
          import.meta.dirname,
          'src/shims/useSyncExternalStoreWithSelector.ts'
        ),
        'use-sync-external-store/shim/with-selector': path.resolve(
          import.meta.dirname,
          'src/shims/useSyncExternalStoreWithSelector.ts'
        ),
        'use-sync-external-store/with-selector': path.resolve(
          import.meta.dirname,
          'src/shims/useSyncExternalStoreWithSelector.ts'
        ),
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'lucide-react',
        'firebase/app',
        'firebase/auth',
        'firebase/firestore',
        'framer-motion',
        'canvas-confetti',
        'recharts',
        'jspdf',
        'jspdf-autotable',
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      target: 'es2020',
      manifest: true,
      cssCodeSplit: true,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('jspdf') || id.includes('jspdf-autotable')) {
              return 'vendor-pdf';
            }
            if (id.includes('recharts')) {
              return 'vendor-charts';
            }
            if (id.includes('firebase')) {
              return 'vendor-firebase';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('framer-motion')) {
              return 'vendor-motion';
            }
          },
        },
      },
    },
  };
});
