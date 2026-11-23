"""Serve only the game's public assets for phone tests on the local Wi-Fi."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse

PUBLIC = {
    "index.html", "salon.html", "salon-v2.html", "online-game.html",
    "firebase-config.js", "online-board.js", "online-engine.js", "online.js", "online-sync.js", "online.css"
}
ROOT = Path(__file__).resolve().parent

class GameHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        name = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        if name not in PUBLIC:
            self.send_error(404)
            return
        if self.path.split("?", 1)[0] == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_HEAD(self):
        name = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        if name not in PUBLIC:
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    ThreadingHTTPServer(("0.0.0.0", args.port), GameHandler).serve_forever()
