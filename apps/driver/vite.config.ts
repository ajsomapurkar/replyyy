import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const api = { '/api': { target: process.env.RELAY_API ?? 'http://localhost:4000', ws: true } };
export default defineConfig({ base: process.env.VITE_BASE ?? '/', plugins: [react()], server: { port: 5175, strictPort: true, proxy: api }, preview: { port: 5175, proxy: api } });
