import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../backend/static" },
  server: { proxy: { "/api": "http://localhost:3003" } },
});
