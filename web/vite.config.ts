import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8840,
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:8841",
      "/socket.io": { target: "http://127.0.0.1:8841", ws: true },
    },
  },
});
