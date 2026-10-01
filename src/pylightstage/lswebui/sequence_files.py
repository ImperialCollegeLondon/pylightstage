"""Bounded decoding and validation of browser-uploaded playback sequences.

Validate the wire representation before model construction: model convenience
normalization deliberately accepts values that an upload must reject.
"""

from __future__ import annotations

import io
import json

import cbor2
import zstandard as zstd

from ..models import PlaybackSequence
from .validation import capture_rate

MAX_SEQUENCE_BYTES = 64 * 1024 * 1024


def _validate_grid(grid: object) -> None:
    if not isinstance(grid, list):
        raise TypeError("Fixture grids must be arrays")
    if not grid:  # An omitted channel leaves those fixtures unchanged.
        return
    if len(grid) != 12 or any(
        not isinstance(row, list) or len(row) != 14 for row in grid
    ):
        raise ValueError("Fixture grids must have 12 arcs and 14 lights per arc")
    for row in grid:
        for value in row:
            if (
                not isinstance(value, list)
                or len(value) != 3
                or any(
                    type(component) is not int or not 0 <= component <= 65535
                    for component in value
                )
            ):
                raise ValueError(
                    "Fixture values must be three integers from 0 to 65535"
                )


def _validate_sequence(data: object) -> PlaybackSequence:
    if not isinstance(data, dict):
        raise TypeError("Sequence must be an object")
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Sequence name must not be empty")
    capture_rate(data.get("capture_hz"))
    frames = data.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("Sequence must contain at least one frame")
    for frame in frames:
        if not isinstance(frame, dict):
            raise TypeError("Each frame must be an object")
        for channel in ("white_fixtures", "rgb_fixtures"):
            _validate_grid(frame.get(channel, []))
    return PlaybackSequence.from_dict(data)


def decode_sequence(payload: bytes, filename: str) -> PlaybackSequence:
    """Read JSON, CBOR, or Zstandard-compressed versions without touching disk."""
    try:
        if not 0 < len(payload) <= MAX_SEQUENCE_BYTES:
            raise ValueError("Sequence file must be between 1 byte and 64 MiB")
        filename = filename.lower()
        if filename.endswith(".zst"):
            filename = filename[:-4]
            with zstd.ZstdDecompressor().stream_reader(io.BytesIO(payload)) as reader:
                payload = reader.read(MAX_SEQUENCE_BYTES + 1)
            if len(payload) > MAX_SEQUENCE_BYTES:
                raise ValueError("Expanded sequence exceeds 64 MiB")
        if filename.endswith(".json"):
            data = json.loads(payload)
        else:
            stream = io.BytesIO(payload)
            data = cbor2.load(stream)
            if stream.read(1):
                raise ValueError("Unexpected data after CBOR sequence")
        return _validate_sequence(data)
    except (
        ValueError,
        TypeError,
        OverflowError,
        EOFError,
        cbor2.CBORDecodeError,
        zstd.ZstdError,
    ) as exc:
        raise ValueError(f"Invalid sequence file: {exc}") from exc
