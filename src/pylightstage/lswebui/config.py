"""Validated settings shared by the launcher and HTTP service."""

from dataclasses import dataclass
from urllib.parse import urlsplit

from ..lscli import DEFAULT_URI

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 8000


@dataclass(frozen=True, slots=True)
class ServerConfig:
    """Settings shared by the HTTP server and browser application."""

    bind: str = DEFAULT_BIND
    port: int = DEFAULT_PORT
    lightstage_uri: str = DEFAULT_URI
    log_requests: bool = False

    def validate(self) -> None:
        if not isinstance(self.bind, str) or not self.bind.strip():
            raise ValueError("bind address must not be empty")
        if type(self.port) is not int or not 0 <= self.port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        uri = urlsplit(self.lightstage_uri)
        if uri.scheme not in ("ws", "wss") or not uri.hostname:
            raise ValueError("LightStage URI must use ws:// or wss:// with a host")
        if uri.fragment:
            raise ValueError("LightStage URI must not contain a fragment")
        _ = uri.port  # Validate malformed and out-of-range ports before binding.
