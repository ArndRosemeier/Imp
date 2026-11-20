import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built files work from any folder of a static host.
  base: './',
  build: { target: 'es2023', sourcemap: true },
  // A module worker, so the audio decoders load as separate files only when a sound is first decoded.
  worker: { format: 'es' },
});
