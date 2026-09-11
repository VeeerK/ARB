"""Dev server for ARB.

getUserMedia() is blocked on file:// URLs, so the app must be served. This adds
the MIME types Python's stdlib misses (.mjs, .wasm) — a wrong Content-Type makes
the browser refuse the ES module or the MediaPipe wasm — and disables caching so
edits show up on reload.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SimpleHTTPRequestHandler.extensions_map.update({
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
})


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Lets MediaPipe use SharedArrayBuffer / threaded wasm where available.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"ARB dev server -> http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=".")).serve_forever()
