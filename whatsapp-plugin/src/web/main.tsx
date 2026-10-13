import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { installHostTheme } from "./theme";
import "./styles.css";

// 必须在首屏渲染前套用：晚一步就会先闪一帧插件的默认品牌色再跳到宿主的主题色。
installHostTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3_000, retry: 1 },
    mutations: { retry: 0 }
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);

