import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: { output: { manualChunks(id) { if (id.includes("/node_modules/@xyflow/")) return "react-flow"; } } },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
    proxy: {
      "/api": "http://127.0.0.1:43172",
    },
  },
  plugins: [react()],
});
