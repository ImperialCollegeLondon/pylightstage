"""HTTP server primitives for the local LightStage web interface."""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import Callable
from dataclasses import asdict, is_dataclass
from enum import Enum
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from .commands import (
    _apply_fixture_control,
    _apply_ibl,
    _control_response,
    _inspect_server,
    _mode_command,
    _sequence_command,
    _trigger_camera,
    _upload_sequence,
)
from .config import DEFAULT_BIND, DEFAULT_PORT, ServerConfig
from .environment_files import MAX_ENVIRONMENT_BYTES, decode_environment
from .sequence_files import MAX_SEQUENCE_BYTES
from .sequence_files import decode_sequence as _decode_sequence

_MAX_REQUEST_BYTES = 32_768
_MAX_SEQUENCE_BYTES = MAX_SEQUENCE_BYTES
_REQUEST_TIMEOUT_SECONDS = 30
_JSON_TYPE = "application/json; charset=utf-8"
_CSP = (
    "default-src 'self'; connect-src 'self' ws: wss:; "
    "img-src 'self' data:; script-src 'self'; style-src 'self'; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": _CSP,
}

# An explicit allowlist prevents arbitrary package files from being served.
_STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/assets/styles.css": ("styles.css", "text/css; charset=utf-8"),
    **{
        f"/assets/{name}.js": (f"{name}.js", "text/javascript; charset=utf-8")
        for name in (
            "api",
            "workspace",
            "ibl",
            "environment-map",
            "environment-image",
            "capture",
            "app",
            "connectivity",
            "inspector",
            "viewport",
            "sequences",
            "simulation",
            "camera",
            "dom",
            "fixture-controls",
            "math",
            "scene",
            "stage-layout",
            "renderers/canvas2d",
            "renderers/labels",
            "renderers/webgpu",
        )
    },
}


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number: {value}")


def _json_default(value: object) -> object:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        default=_json_default,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode()


def _browser_config(config: ServerConfig) -> dict[str, object]:
    return {
        "bind": config.bind,
        "port": config.port,
        "lightstage_uri": config.lightstage_uri,
        "webgpu": {"preferred": True, "fallback": "canvas2d"},
        "features": {"fixture_control": True},
    }


def _stage_error(
    exc: Exception, config: ServerConfig, operation: str
) -> tuple[HTTPStatus, str]:
    """Map client, validation, and protocol failures to the public HTTP API."""

    if isinstance(exc, (ValueError, IndexError, TypeError, OverflowError)):
        return HTTPStatus.BAD_REQUEST, str(exc)
    if isinstance(exc, TimeoutError):
        return (
            HTTPStatus.GATEWAY_TIMEOUT,
            str(exc) or f"Timed out connecting to {config.lightstage_uri}",
        )
    if isinstance(exc, OSError):
        return (
            HTTPStatus.BAD_GATEWAY,
            f"Could not connect to {config.lightstage_uri}: {exc}",
        )
    if operation == "command" and isinstance(exc, RuntimeError):
        return HTTPStatus.BAD_GATEWAY, f"LightStage protocol error: {exc}"
    detail = exc or "no details provided"
    return (
        HTTPStatus.BAD_GATEWAY,
        (
            f"LightStage {operation} failed at {config.lightstage_uri}: "
            f"{type(exc).__name__}: {detail}"
        ),
    )


class LightStageWebServer(ThreadingHTTPServer):
    """Thread-per-request server with prompt process shutdown semantics."""

    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False


def _handler_for(config: ServerConfig) -> type[BaseHTTPRequestHandler]:
    static_root = files("pylightstage.lswebui").joinpath("static")

    class WebUIRequestHandler(BaseHTTPRequestHandler):
        server_version = "pylightstage-lswebui"
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            self._handle(head_only=False)

        def do_HEAD(self) -> None:
            self._handle(head_only=True)

        def do_POST(self) -> None:
            # POST errors may leave a body unread. Never reuse such a connection.
            self.close_connection = True
            try:
                request_url = urlsplit(self.path)
                path = unquote(request_url.path)
                command_handlers = {
                    "/api/mode": _mode_command,
                    "/api/sequences": _sequence_command,
                    "/api/ibl": _apply_ibl,
                }
                if path == "/api/ibl/import":
                    body = self._read_body(
                        MAX_ENVIRONMENT_BYTES,
                        "Environment image must be between 1 byte and 64 MiB",
                    )
                    params = parse_qs(request_url.query)
                    response = {
                        "result": decode_environment(
                            body,
                            params.get("filename", [""])[0],
                            params.get("colour_space", ["auto"])[0],
                        )
                    }
                elif path in ("/api/sequences/import", "/api/sequences/preview"):
                    body = self._read_body(
                        _MAX_SEQUENCE_BYTES,
                        "Sequence file must be between 1 byte and 64 MiB",
                    )
                    filename = parse_qs(request_url.query).get("filename", [""])[0]
                    sequence = _decode_sequence(body, filename.lower())
                    response = {
                        "result": (
                            sequence.to_dict()
                            if path == "/api/sequences/preview"
                            else asyncio.run(_upload_sequence(config, sequence))
                        )
                    }
                elif path in (*command_handlers, "/api/capture", "/api/fixture"):
                    payload = self._read_json_object()
                    if path == "/api/fixture":
                        asyncio.run(_apply_fixture_control(config, payload))
                        response = _control_response(payload)
                    else:
                        command = (
                            _trigger_camera(config)
                            if path == "/api/capture"
                            else command_handlers[path](config, payload)
                        )
                        response = {"result": asyncio.run(command)}
                else:
                    self._send_error(
                        HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed"
                    )
                    return
                self._send_json(response, head_only=False)
            except Exception as exc:  # noqa: BLE001 - HTTP error boundary
                self._send_stage_error(exc, "command")

        def _read_body(self, limit: int, message: str) -> bytes:
            if self.headers.get("Transfer-Encoding") is not None:
                raise ValueError("Transfer-Encoding is not supported")
            lengths = self.headers.get_all("Content-Length", [])
            if (
                len(lengths) != 1
                or not lengths[0].isascii()
                or not lengths[0].isdigit()
            ):
                raise ValueError("A single integer Content-Length is required")
            length = int(lengths[0])
            if not 0 < length <= limit:
                raise ValueError(message)
            self.connection.settimeout(_REQUEST_TIMEOUT_SECONDS)
            try:
                body = self.rfile.read(length)
            except TimeoutError as exc:
                raise ValueError("Timed out reading request body") from exc
            if len(body) != length:
                raise ValueError("Incomplete request body")
            return body

        def _read_json_object(self) -> dict[str, Any]:
            body = self._read_body(_MAX_REQUEST_BYTES, "request body must contain JSON")
            payload = json.loads(body, parse_constant=_reject_json_constant)
            if not isinstance(payload, dict):
                raise TypeError("request body must be a JSON object")
            return payload

        def _handle(self, *, head_only: bool) -> None:
            try:
                self._handle_get(head_only=head_only)
            except Exception as exc:  # noqa: BLE001 - HTTP error boundary
                self.close_connection = True
                self._send_stage_error(exc, "query", head_only=head_only)

        def _handle_get(self, *, head_only: bool) -> None:
            request_url = urlsplit(self.path)
            path = unquote(request_url.path)
            if path == "/api/health":
                self._send_json(
                    {"service": "lswebui", "status": "ok"}, head_only=head_only
                )
                return
            if path == "/api/config":
                self._send_json(_browser_config(config), head_only=head_only)
                return
            if path == "/api/inspect":
                action = parse_qs(request_url.query).get("action", [""])[0]
                result = asyncio.run(_inspect_server(config, action))
                self._send_json(
                    {"action": action, "result": result}, head_only=head_only
                )
                return

            asset = _STATIC_FILES.get(path)
            if asset is None:
                self._send_error(HTTPStatus.NOT_FOUND, "Not found", head_only=head_only)
                return
            relative_path, content_type = asset
            try:
                body = static_root.joinpath(*relative_path.split("/")).read_bytes()
            except (FileNotFoundError, OSError):
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "Packaged web asset is unavailable",
                    head_only=head_only,
                )
                return
            self._send(HTTPStatus.OK, body, content_type, head_only=head_only)

        def _send_json(self, value: object, *, head_only: bool) -> None:
            try:
                body = _json_bytes(value)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(
                    "LightStage returned data that is not valid JSON"
                ) from exc
            self._send(
                HTTPStatus.OK,
                body,
                _JSON_TYPE,
                head_only=head_only,
                cache_control="no-store",
            )

        def _send_stage_error(
            self,
            exc: Exception,
            operation: str,
            *,
            head_only: bool = False,
        ) -> None:
            status, message = _stage_error(exc, config, operation)
            self._send_error(status, message, head_only=head_only)

        def _send_error(
            self,
            status: HTTPStatus,
            message: str,
            *,
            head_only: bool = False,
        ) -> None:
            self._send(
                status,
                _json_bytes({"error": message}),
                _JSON_TYPE,
                head_only=head_only,
                cache_control="no-store",
            )

        def _send(
            self,
            status: HTTPStatus,
            body: bytes,
            content_type: str,
            *,
            head_only: bool,
            cache_control: str = "no-cache",
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache_control)
            if self.close_connection:
                self.send_header("Connection", "close")
            for name, value in _SECURITY_HEADERS.items():
                self.send_header(name, value)
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            if config.log_requests:
                super().log_message(format, *args)

    return WebUIRequestHandler


def create_server(config: ServerConfig) -> LightStageWebServer:
    """Create, bind, and return a configured local web server.

    A port of ``0`` asks the operating system to select an unused port, which
    is especially useful when embedding the UI or running tests.
    """

    config.validate()
    address_family = _address_family(config.bind, config.port)
    server_type = type(
        "ConfiguredLightStageWebServer",
        (LightStageWebServer,),
        {"address_family": address_family},
    )
    return server_type((config.bind, config.port), _handler_for(config))


def _address_family(bind: str, port: int) -> socket.AddressFamily:
    """Choose a socket family while retaining host-name support."""

    flags = socket.AI_PASSIVE if bind in ("0.0.0.0", "::") else 0
    addresses = socket.getaddrinfo(bind, port, type=socket.SOCK_STREAM, flags=flags)
    if not addresses:
        raise OSError(f"could not resolve bind address {bind!r}")
    if ":" in bind:
        for family, *_ in addresses:
            if family == socket.AF_INET6:
                return socket.AF_INET6
    for family, *_ in addresses:
        if family == socket.AF_INET:
            return socket.AF_INET
    return addresses[0][0]


ServerFactory = Callable[[ServerConfig], LightStageWebServer]


__all__ = [
    "DEFAULT_BIND",
    "DEFAULT_PORT",
    "LightStageWebServer",
    "ServerConfig",
    "ServerFactory",
    "create_server",
]
