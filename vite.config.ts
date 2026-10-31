import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        hmr: false,
      },
      plugins: [
        react(), 
        tailwindcss(),
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['favicon.ico', 'logo.png', 'pharmaflow_icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
          manifest: {
            id: '/',
            name: 'PharmaFlow Pro',
            short_name: 'PharmaFlow',
            description: 'تطبيق مالي ومحاسبي متكامل لإدارة الحسابات والديون للشركات والصيدليات مع دعم أوفلاين كامل.',
            theme_color: '#1E4D4D',
            background_color: '#ffffff',
            display: 'standalone',
            start_url: '/',
            scope: '/',
            icons: [
              {
                src: '/pwa-192x192.png',
                sizes: '192x192',
                type: 'image/png',
                purpose: 'any'
              },
              {
                src: '/pwa-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any'
              },
              {
                src: '/pwa-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable'
              }
            ]
          },
          devOptions: {
            enabled: true,
            type: 'module'
          }
        })
      ],
      base: '/',
      assetsInclude: ['**/*.png', '**/*.jpg', '**/*.svg', '**/*.PNG', '**/*.JPG', '**/*.JPEG', '**/*.jpeg'],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, 'src'),
          '@features': path.resolve(__dirname, 'src/features')
        }
      },
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        target: 'es2022',
        minify: 'esbuild',
        cssCodeSplit: true,
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (id.includes('node_modules')) {
                if (id.includes('react/') || id.includes('react-dom/') || id.includes('react-router')) {
                  return 'vendor-core';
                }
                if (id.includes('lucide-react')) {
                  return 'vendor-icons';
                }
                if (id.includes('firebase')) {
                  return 'vendor-firebase';
                }
                if (id.includes('pdfjs-dist') || id.includes('jspdf') || id.includes('tesseract.js')) {
                  return 'vendor-heavy';
                }
              }
            }
          }
        }
      }
    };
});

