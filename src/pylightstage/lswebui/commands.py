"""Validate complete commands before opening a connection to stage hardware.

Each operation uses one client session. Do not retry a failed command: part of it
may already have reached the stage, even when no acknowledgement was received.
"""

from typing import Any

from ..client import LightStageClient
from ..models import ColorMode, PlaybackSequence, PolarizationMode
from ..utils import color_mode, polarization_mode, validate_index, validate_intensity
from .config import ServerConfig
from .validation import capture_rate

_INSPECT_ACTIONS = {
    "get-config": "get_config",
    "get-mode": "get_mode",
    "list-sequences": "list_sequences",
}
_CONTROL_TARGETS = ("fixture", "arc", "horizontal_arc")
_NUM_ARCS = 12
_LIGHTS_PER_ARC = 14


def _required_index(payload: dict[str, Any], name: str, size: int) -> int:
    value = payload.get(name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    return validate_index(name, value, size=size)


def _control_target(payload: dict[str, Any]) -> tuple[str, int | None, int | None]:
    target = payload.get("target", "fixture")
    if target not in _CONTROL_TARGETS:
        choices = ", ".join(repr(choice) for choice in _CONTROL_TARGETS)
        raise ValueError(f"target must be one of: {choices}")
    arc = (
        _required_index(payload, "arc", _NUM_ARCS)
        if target in ("fixture", "arc")
        else None
    )
    light = (
        _required_index(payload, "light", _LIGHTS_PER_ARC)
        if target in ("fixture", "horizontal_arc")
        else None
    )
    return target, arc, light


def _control_targets(
    payload: dict[str, Any],
) -> list[tuple[str, int | None, int | None]]:
    raw_targets = payload.get("targets")
    if "targets" not in payload:
        return [_control_target(payload)]
    if not isinstance(raw_targets, list) or not raw_targets:
        raise TypeError("targets must be a non-empty array")

    targets: list[tuple[str, int | None, int | None]] = []
    for raw_target in raw_targets:
        if not isinstance(raw_target, dict):
            raise TypeError("each target must be a JSON object")
        target = _control_target(raw_target)
        if target not in targets:
            targets.append(target)
    return targets


async def _apply_fixture_control(config: ServerConfig, payload: dict[str, Any]) -> None:
    """Apply one explicit fixture or fixture-group action through the client API."""

    action = payload.get("action")
    if action not in ("set", "clear"):
        raise ValueError("action must be 'set' or 'clear'")
    targets = _control_targets(payload)
    raw_intensity = (
        [0, 0, 0] if action == "clear" else payload.get("intensity", [255, 255, 255])
    )
    if not isinstance(raw_intensity, list) or any(
        type(value) not in (int, float) for value in raw_intensity
    ):
        raise ValueError("intensity must be an array of three numbers")
    intensity = validate_intensity(raw_intensity)

    selector = payload.get("selector", "direct")
    color: ColorMode | None = None
    polarization: PolarizationMode | None = None
    if selector == "direct":
        color = color_mode(payload.get("color", "rgbw"))
    elif selector == "polarized":
        polarization = polarization_mode(payload.get("polarization", "up"))
    else:
        raise ValueError("selector must be 'direct' or 'polarized'")

    async with LightStageClient(uri=config.lightstage_uri) as client:
        if color is not None:
            for target, arc, light in targets:
                if target == "fixture":
                    assert arc is not None and light is not None
                    await client.set_light(
                        light=light,
                        arc=arc,
                        color=color,
                        intensity=intensity,
                    )
                elif target == "arc":
                    assert arc is not None
                    await client.set_arc(arc=arc, color=color, intensity=intensity)
                else:
                    assert light is not None
                    await client.set_horizontal_arc(
                        light=light,
                        color=color,
                        intensity=intensity,
                    )
        else:
            assert polarization is not None
            fixtures: set[tuple[int, int]] = set()
            for target, arc, light in targets:
                if target == "fixture":
                    assert arc is not None and light is not None
                    fixtures.add((arc, light))
                elif target == "arc":
                    assert arc is not None
                    fixtures.update(
                        (arc, light_index) for light_index in range(_LIGHTS_PER_ARC)
                    )
                else:
                    assert light is not None
                    fixtures.update(
                        (arc_index, light) for arc_index in range(_NUM_ARCS)
                    )

            if len(fixtures) == 1:
                arc, light = fixtures.pop()
                await client.set_pol_light(
                    light=light,
                    arc=arc,
                    pol=polarization,
                    intensity=intensity,
                )
            else:
                for arc_index, light_index in sorted(fixtures):
                    await client.set_pol_light(
                        light=light_index,
                        arc=arc_index,
                        pol=polarization,
                        intensity=intensity,
                        go=False,
                    )
                await client.go()


async def _apply_ibl(config: ServerConfig, payload: dict[str, Any]) -> None:
    """Validate the entire RGB pattern before changing mode or queuing fixtures."""
    values = payload.get("intensities")
    if not isinstance(values, list) or len(values) != _NUM_ARCS * _LIGHTS_PER_ARC:
        raise ValueError("intensities must contain 168 RGB triplets")
    intensities = []
    for value in values:
        if not isinstance(value, list) or any(
            type(channel) not in (int, float) for channel in value
        ):
            raise ValueError("each intensity must be an array of three numbers")
        intensities.append(validate_intensity(value))
    async with LightStageClient(uri=config.lightstage_uri) as client:
        await client.set_mode_manual()
        for index, intensity in enumerate(intensities):
            arc, light = divmod(index, _LIGHTS_PER_ARC)
            await client.set_light(light, arc, "rgb", intensity, go=False)
            await client.set_light(light, arc, "w", (0, 0, 0), go=False)
        await client.go()


def _control_response(payload: dict[str, Any]) -> dict[str, Any]:
    """Return target-aware metadata while preserving the original fixture response."""

    if "targets" in payload:
        return {
            "status": "ok",
            "targets": payload["targets"],
            "action": payload["action"],
        }
    if "target" not in payload:
        return {
            "status": "ok",
            "arc": payload["arc"],
            "light": payload["light"],
            "action": payload["action"],
        }

    target = payload["target"]
    response = {"status": "ok", "target": target, "action": payload["action"]}
    if target in ("fixture", "arc"):
        response["arc"] = payload["arc"]
    if target in ("fixture", "horizontal_arc"):
        response["light"] = payload["light"]
    return response


async def _inspect_server(config: ServerConfig, action: str) -> Any:
    """Run one read-only action from lscli's Inspect Server submenu."""

    method_name = _INSPECT_ACTIONS.get(action)
    if method_name is None:
        choices = ", ".join(sorted(_INSPECT_ACTIONS))
        raise ValueError(f"action must be one of: {choices}")
    async with LightStageClient(uri=config.lightstage_uri) as client:
        return await getattr(client, method_name)()


async def _trigger_camera(config: ServerConfig) -> Any:
    async with LightStageClient(uri=config.lightstage_uri) as client:
        return await client.trigger()


async def _mode_command(config: ServerConfig, payload: dict[str, Any]) -> Any:
    mode = payload.get("mode")
    if mode not in ("olat", "manual"):
        raise ValueError("mode must be olat or manual")
    if mode == "manual" and "capture_hz" in payload:
        raise ValueError("capture_hz is only valid for olat mode")
    rate = capture_rate(payload.get("capture_hz")) if mode == "olat" else None
    async with LightStageClient(uri=config.lightstage_uri) as client:
        if rate is not None:
            return await client.set_mode_olat(rate)
        return await client.set_mode_manual()


async def _sequence_command(config: ServerConfig, payload: dict[str, Any]) -> Any:
    action = payload.get("action")
    if action not in ("play", "delete", "manual"):
        raise ValueError("action must be play, delete, or manual")
    sequence_id = payload.get("id", "")
    if action != "manual" and (
        not isinstance(sequence_id, str) or not sequence_id.strip()
    ):
        raise ValueError("Sequence id is required")
    async with LightStageClient(uri=config.lightstage_uri) as client:
        if action == "manual":
            return await client.set_mode_manual()
        assert isinstance(sequence_id, str)  # Validated before opening the client.
        if action == "play":
            return await client.set_mode_playback(sequence_id)
        return await client.delete_sequence(sequence_id)


async def _upload_sequence(config: ServerConfig, sequence: PlaybackSequence) -> Any:
    async with LightStageClient(uri=config.lightstage_uri) as client:
        return await client.upload_sequence(sequence)
