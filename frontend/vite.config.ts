import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/whatsapp-plugin/api": {
        target: "http://127.0.0.1:3100",
        rewrite: (path) => path.replace(/^\/whatsapp-plugin\/api/u, "/api")
      },
      "/whatsapp-plugin/socket.io": {
        target: "http://127.0.0.1:3100",
        ws: true,
        rewrite: (path) => path.replace(/^\/whatsapp-plugin\/socket\.io/u, "/socket.io")
      },
      "/whatsapp-plugin": {
        target: "http://127.0.0.1:5193",
        ws: true
      },
      "/api": process.env.VITE_API_TARGET || "http://127.0.0.1:4188"
    }
  }
});
