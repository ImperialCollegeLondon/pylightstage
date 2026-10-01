"""Validation shared by HTTP commands and uploaded sequences."""

import math


def capture_rate(value: object) -> float:
    """Require a positive finite JSON number, without coercing strings or booleans."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("capture_hz must be a positive finite number")  # noqa: TRY004 - validation API
    try:
        rate = float(value)
    except OverflowError as exc:
        raise ValueError("capture_hz must be a positive finite number") from exc
    if not math.isfinite(rate) or rate <= 0:
        raise ValueError("capture_hz must be a positive finite number")
    return rate
