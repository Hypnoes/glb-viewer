#!/usr/bin/env python3
"""Zero-dependency local server for GLB Inspector / NEON RANGE scene inspector.

Usage:
    python serve.py                         # http://127.0.0.1:8123/
    python serve.py 9000                    # alternate port
    python serve.py 8126 --assets PATH      # alternate project-asset root
    NEON_PROJECT_ASSETS=PATH python serve.py

The default project-asset root is the sibling NEON RANGE checkout:

    ..\\fps-demo\\assets

It is exposed read-only at /project-assets/. GET and HEAD are the only allowed
methods; path traversal and non-asset file extensions are rejected. The server
always binds to 127.0.0.1, so the route is localhost-only by construction, and
each request is additionally checked against the loopback peer address.
"""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import sys
import urllib.parse
from functools import partial

PROJECT_ASSETS_PREFIX = "/project-assets/"
PROJECT_STATUS_PATH = "/api/project-assets"
PROJECT_ASSET_EXTENSIONS = {
    ".json",
    ".glb",
    ".gltf",
    ".bin",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".ktx2",
    ".hdr",
    ".exr",
    ".svg",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".txt",
    ".md",
}

DEFAULT_ASSETS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "fps-demo",
    "assets",
)

CHECKOUT_ROOT = os.path.dirname(os.path.abspath(__file__))


def _project_asset_url(*parts: str) -> str:
    return PROJECT_ASSETS_PREFIX + "/".join(part.strip("/") for part in parts if part)


def _display_root(path: str) -> str:
    """Report the asset root checkout-relative, never as a local absolute path."""
    try:
        relative = os.path.relpath(path, CHECKOUT_ROOT)
    except ValueError:
        return os.path.basename(path)
    return relative.replace("\\", "/")


class InspectorHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".bin": "application/octet-stream",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".ktx2": "image/ktx2",
        ".webp": "image/webp",
        ".avif": "image/avif",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }

    # Replaced from main() before the server starts.
    project_assets_dir = DEFAULT_ASSETS_DIR

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Keep the console readable during asset review.
        sys.stdout.write("[serve] %s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self._is_project_route():
            self._serve_project_asset(head=False)
            return
        if self._request_path() == PROJECT_STATUS_PATH:
            self._serve_project_status(head=False)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
        if self._is_project_route():
            self._serve_project_asset(head=True)
            return
        if self._request_path() == PROJECT_STATUS_PATH:
            self._serve_project_status(head=True)
            return
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        self._reject_write()

    def do_PUT(self) -> None:  # noqa: N802 - stdlib naming
        self._reject_write()

    def do_PATCH(self) -> None:  # noqa: N802 - stdlib naming
        self._reject_write()

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib naming
        self._reject_write()

    def _request_path(self) -> str:
        return urllib.parse.urlsplit(self.path).path

    def _is_project_route(self) -> bool:
        path = self._request_path()
        return path == PROJECT_ASSETS_PREFIX.rstrip("/") or path.startswith(PROJECT_ASSETS_PREFIX)

    def _reject_write(self) -> None:
        if not self._is_project_route() and self._request_path() != PROJECT_STATUS_PATH:
            self.send_error(405, "Method not allowed")
            return
        self._send_json(
            405,
            {
                "error": "read-only route",
                "route": PROJECT_ASSETS_PREFIX,
                "method": self.command,
                "allow": ["GET", "HEAD"],
            },
            extra_headers={"Allow": "GET, HEAD"},
        )

    # ------------------------------------------------------------------
    # /project-assets/ (read-only files)
    # ------------------------------------------------------------------

    def _serve_project_asset(self, *, head: bool) -> None:
        if not self._is_local_client():
            self._send_json(403, {"error": "project assets are localhost-only"}, head=head)
            return

        full_path, root = self._resolve_project_path()
        if full_path is None:
            self._send_json(
                404,
                {
                    "error": "invalid project-asset path",
                    "requested": self._request_path(),
                    "assetsRoot": root,
                    "hint": "Only plain paths below /project-assets/ are served; '..' is rejected.",
                },
                head=head,
            )
            return

        if not os.path.isfile(full_path):
            extension = os.path.splitext(full_path)[1].lower()
            if extension and extension not in PROJECT_ASSET_EXTENSIONS:
                self._send_json(
                    415,
                    {
                        "error": "unsupported asset extension",
                        "extension": extension,
                        "allowed": sorted(PROJECT_ASSET_EXTENSIONS),
                    },
                    head=head,
                )
                return
            self._send_json(
                404,
                {
                    "error": "project asset not found",
                    "requested": self._request_path(),
                    "assetsRoot": root,
                    "available": os.path.isdir(root),
                    "hint": "Start serve.py with --assets <dir> if the NEON RANGE checkout is elsewhere.",
                },
                head=head,
            )
            return

        extension = os.path.splitext(full_path)[1].lower()
        if extension not in PROJECT_ASSET_EXTENSIONS:
            self._send_json(
                415,
                {
                    "error": "unsupported asset extension",
                    "extension": extension,
                    "allowed": sorted(PROJECT_ASSET_EXTENSIONS),
                },
                head=head,
            )
            return

        try:
            with open(full_path, "rb") as handle:
                payload = handle.read()
        except OSError as exc:
            self._send_json(500, {"error": "could not read project asset", "detail": str(exc)}, head=head)
            return

        content_type = self.extensions_map.get(extension, "application/octet-stream")
        if content_type.startswith("text/") or content_type in ("application/json", "model/gltf+json"):
            content_type = f"{content_type}; charset=utf-8"
        self._send_payload(200, payload, content_type=content_type, head=head)

    def _resolve_project_path(self) -> tuple[str | None, str]:
        root = os.path.realpath(self.project_assets_dir)
        raw = urllib.parse.unquote(self._request_path())
        if "\x00" in raw:
            return None, root
        relative = raw[len(PROJECT_ASSETS_PREFIX):] if raw.startswith(PROJECT_ASSETS_PREFIX) else ""
        relative = relative.replace("\\", "/").lstrip("/")
        segments = [segment for segment in relative.split("/") if segment not in ("", ".")]
        if not segments or any(segment == ".." for segment in segments):
            return None, root

        candidate = os.path.realpath(os.path.join(root, *segments))
        try:
            if os.path.commonpath([root, candidate]) != root:
                return None, root
        except ValueError:
            return None, root
        return candidate, root

    # ------------------------------------------------------------------
    # /api/project-assets (read-only discovery helper)
    # ------------------------------------------------------------------

    def _serve_project_status(self, *, head: bool) -> None:
        if not self._is_local_client():
            self._send_json(403, {"error": "project assets are localhost-only"}, head=head)
            return

        root = os.path.realpath(self.project_assets_dir)
        available = os.path.isdir(root)
        payload = {
            "route": PROJECT_ASSETS_PREFIX,
            "statusPath": PROJECT_STATUS_PATH,
            "available": available,
            "readOnly": True,
            "root": _display_root(root),
            "manifest": None,
            "scene": None,
            "uiLayout": None,
            "scenes": [],
            "note": None,
        }
        if not available:
            payload["note"] = (
                "Project assets directory does not exist. Start serve.py with "
                "--assets <path> to point at the NEON RANGE assets directory."
            )
            self._send_json(200, payload, head=head)
            return

        manifest_path = os.path.join(root, "manifest.json")
        if os.path.isfile(manifest_path):
            payload["manifest"] = _project_asset_url("manifest.json")

        scenes_dir = os.path.join(root, "scenes")
        if os.path.isdir(scenes_dir):
            scenes = sorted(
                name for name in os.listdir(scenes_dir) if name.endswith(".scene.json")
            )
            payload["scenes"] = [_project_asset_url("scenes", name) for name in scenes]
            if scenes:
                preferred = "range.scene.json" if "range.scene.json" in scenes else scenes[0]
                payload["scene"] = _project_asset_url("scenes", preferred)

        ui_layout = os.path.join(root, "ui", "layout.json")
        if os.path.isfile(ui_layout):
            payload["uiLayout"] = _project_asset_url("ui", "layout.json")

        self._send_json(200, payload, head=head)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _is_local_client(self) -> bool:
        return bool(self.client_address) and self.client_address[0] in ("127.0.0.1", "::1")

    def _send_json(
        self,
        status: int,
        payload: dict,
        *,
        head: bool = False,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = (json.dumps(payload, indent=2) + "\n").encode("utf-8")
        self._send_payload(
            status,
            body,
            content_type="application/json; charset=utf-8",
            head=head,
            extra_headers=extra_headers,
        )

    def _send_payload(
        self,
        status: int,
        body: bytes,
        *,
        content_type: str,
        head: bool = False,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Project-Assets", "read-only")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if not head:
            self.wfile.write(body)


class ReusableThreadingTCPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _print_usage() -> None:
    print(__doc__)
    print(f"Default project assets: {DEFAULT_ASSETS_DIR}")


def main() -> None:
    port = 8123
    assets_dir = os.environ.get("NEON_PROJECT_ASSETS") or DEFAULT_ASSETS_DIR

    args = sys.argv[1:]
    index = 0
    while index < len(args):
        argument = args[index]
        if argument in ("-h", "--help"):
            _print_usage()
            return
        if argument == "--assets":
            index += 1
            if index >= len(args):
                raise SystemExit("--assets requires a directory path")
            assets_dir = args[index]
        elif argument.startswith("--assets="):
            assets_dir = argument.split("=", 1)[1]
        else:
            try:
                port = int(argument)
            except ValueError as exc:
                raise SystemExit(f"Invalid argument: {argument}") from exc
        index += 1

    InspectorHandler.project_assets_dir = os.path.abspath(assets_dir)
    root = os.path.dirname(os.path.abspath(__file__))
    handler = partial(InspectorHandler, directory=root)
    with ReusableThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"GLB Inspector serving {root}")
        print(f"Open http://127.0.0.1:{port}/")
        print(f"Project assets (read-only): {InspectorHandler.project_assets_dir}")
        print(f"  http://127.0.0.1:{port}{PROJECT_ASSETS_PREFIX}")
        print(f"  http://127.0.0.1:{port}{PROJECT_STATUS_PATH}")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server.")


if __name__ == "__main__":
    main()
