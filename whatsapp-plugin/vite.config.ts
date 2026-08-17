import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "/whatsapp-plugin/",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@web": path.resolve(__dirname, "src/web")
    }
  },
  server: {
    port: 5193,
    strictPort: true,
    proxy: {
      "/api/customers": {
        target: "http://127.0.0.1:4188"
      },
      "/api/todos": {
        target: "http://127.0.0.1:4188"
      },
      "/whatsapp-plugin/api": {
        target: "http://127.0.0.1:3100",
        rewrite: (requestPath) => requestPath.replace(/^\/whatsapp-plugin\/api/u, "/api")
      },
      "/whatsapp-plugin/socket.io": {
        target: "http://127.0.0.1:3100",
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/whatsapp-plugin\/socket\.io/u, "/socket.io")
      }
    }
  }
});
