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
      // 默认必须指向开发档 4190：这里原来是 4188（个人档）。
      // 后果是 vite dev 页面是新的、API 却打到个人档后端，一旦那边进程没跟着重启
      // 就会出现「界面画得出来、数据全加载失败」（订单页 404 就是这么来的），
      // 而且等于让开发中的前端直连真实数据。要连别的档位请显式给 VITE_API_TARGET。
      "/uploads": process.env.VITE_API_TARGET || "http://127.0.0.1:4190",
      "/api": process.env.VITE_API_TARGET || "http://127.0.0.1:4190"
    }
  }
});
