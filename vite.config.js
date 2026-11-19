import { defineConfig } from 'vite';

// base './' để chạy được cả ở tên miền gốc (Vercel, Netlify) lẫn thư mục con (GitHub Pages)
export default defineConfig({
  base: './',
  build: { outDir: 'dist', sourcemap: false },
});
