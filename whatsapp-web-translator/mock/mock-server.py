#!/usr/bin/env python3
"""本地 mock 服务：给扩展做端到端自检用，不连任何真实服务。

两个角色：
  1. 静态托管 `mock/mock-whatsapp.html` —— 复刻 WhatsApp Web 的消息 DOM 结构
  2. 假的 OpenAI 兼容接口 `/v1/chat/completions` —— 返回可预测的译文，并把
     最后一次请求（含 Authorization / model / prompt）记下来，供断言校验

行为开关（写在消息文本里）：
  含 FAIL401 → 返回 401，用来验证失败态与重试
  含 SLOW    → 延迟 1.5 秒返回，用来验证 pending 态

只用标准库，避免给项目加依赖。
"""

from __future__ import annotations

import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAST = {"request": None, "count": 0}
FAILS = {"fail401": 0}
REQUESTS: list = []


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *args):  # 静音，避免污染测试输出
        return

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/__requests"):
            self._json(200, {"count": len(REQUESTS), "requests": REQUESTS, "last": LAST})
            return
        if self.path.startswith("/__last"):
            self._json(200, LAST)
            return
        if self.path.startswith("/__reset"):
            LAST["request"] = None
            LAST["count"] = 0
            FAILS["fail401"] = 0
            REQUESTS.clear()
            self._json(200, {"ok": True})
            return
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {"__unparsed": raw.decode("utf-8", "replace")}

        LAST["count"] += 1
        LAST["request"] = {
            "path": self.path,
            "authorization": self.headers.get("authorization"),
            "contentType": self.headers.get("content-type"),
            "body": body,
        }

        user_content = ""
        messages = body.get("messages") or []
        if messages:
            user_content = str(messages[-1].get("content") or "")
        REQUESTS.append(
            {
                "path": self.path,
                "authorization": self.headers.get("authorization"),
                "body": body,
                "userContent": user_content,
            }
        )

        if not self.path.startswith("/v1/chat/completions"):
            self._json(404, {"error": {"message": "not found"}})
            return

        if "FAIL401" in user_content:
            # 只失败第一次：这样能验证「点重试后能成功」这条路径
            FAILS["fail401"] += 1
            if FAILS["fail401"] <= 1:
                self._json(401, {"error": {"message": "invalid api key"}})
                return

        if "SLOW" in user_content:
            time.sleep(1.5)

        # 从 prompt 里挖出待译正文（"Translate from xx to yy:\n\n<正文>"）
        text = user_content.split("\n\n", 1)[1] if "\n\n" in user_content else user_content
        self._json(
            200,
            {
                "id": "mock-completion",
                "model": body.get("model"),
                "choices": [{"message": {"role": "assistant", "content": f"[MOCK译] {text}"}}],
                "usage": {"total_tokens": 42},
            },
        )


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock server on http://127.0.0.1:{port} (root={ROOT})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
