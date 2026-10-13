"""Loopback-only caption fixture; serves the real overlay with synthetic state."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json

STATIC = Path(__file__).resolve().parent.parent / "static"

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/voice-subtitle.js":
            content = (STATIC / "voice-subtitle.js").read_text(encoding="utf-8")
            mime = "text/javascript"
        elif url.path in ("/", "/overlay.html"):
            query = parse_qs(url.query)
            state = {
                "phase": query.get("phase", ["recording"])[0],
                "transcript": "Earlier spoken words. " * 100 + "jogging puppy g j p q y",
                "assistant": "Which day should I mention?" if query.get("question", ["1"])[0] == "1" else "",
                "statusText": query.get("status", [""])[0],
                "connectionStatus": query.get("connection", [""])[0],
                "retryText": query.get("retry", [""])[0],
                "budgetWarning": query.get("budget", [""])[0],
            }
            width = int(query.get("width", ["420"])[0])
            script = f"<style>body{{width:{width}px;height:240px}}</style><script>window.__WM_VOICE={json.dumps(state)};window.__WM_OVERLAY_SET_STATE('recording');window.__WM_RENDER_VOICE();</script>"
            content = (STATIC / "overlay.html").read_text(encoding="utf-8").replace("</body>", script + "</body>")
            mime = "text/html"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8899), Handler).serve_forever()
