import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` genera dist/index.html como un único archivo (JS y CSS incluidos),
// que se puede abrir con doble clic sin servidor.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
});
