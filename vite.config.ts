import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { codeVersion } from './scripts/version.ts';
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  define: { __CODE_VERSION__: JSON.stringify(codeVersion()) },
});
