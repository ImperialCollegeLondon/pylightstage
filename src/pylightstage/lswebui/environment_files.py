"""Native panorama decoding and full-precision, solid-angle integration.

Only a compact latitude integral and a display thumbnail leave the local server.
The thumbnail is never used to calculate lighting, and imports touch no hardware.
"""

from __future__ import annotations

import math
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import OpenImageIO as oiio

MAX_ENVIRONMENT_BYTES = 64 * 1024 * 1024
MAX_ENVIRONMENT_PIXELS = 32 * 1024 * 1024
MAX_ENVIRONMENT_WIDTH = 16384
_LIGHTS_PER_ARC = 14
_MAX_ELEVATION = 1.08  # stage-layout.js; parity is covered by browser regressions.
_FORMATS = {
    ".hdr": "hdr",
    ".rgbe": "hdr",
    ".exr": "openexr",
    ".tif": "tiff",
    ".tiff": "tiff",
    ".pfm": "pnm",
    ".png": "png",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".webp": "webp",
}
_COLOUR_SPACES = {
    "linear": "lin_rec709_scene",
    "srgb": "srgb_rec709_scene",
    "acescg": "lin_ap1_scene",
    "aces2065-1": "lin_ap0_scene",
}


def _dimensions(width: int, height: int) -> None:
    if width < 1 or height < 1 or width * height > MAX_ENVIRONMENT_PIXELS:
        raise ValueError("Panorama must contain between 1 and 32 MiPixels")
    if max(width, height) > MAX_ENVIRONMENT_WIDTH:
        raise ValueError("Panorama dimensions must not exceed 16384 pixels")


def _orient(pixels: np.ndarray, orientation: int) -> np.ndarray:
    if orientation == 2:
        return pixels[:, ::-1]
    if orientation == 3:
        return pixels[::-1, ::-1]
    if orientation == 4:
        return pixels[::-1]
    if orientation == 5:
        return pixels.transpose(1, 0, 2)
    if orientation == 6:
        return np.rot90(pixels, -1)
    if orientation == 7:
        return pixels.transpose(1, 0, 2)[::-1, ::-1]
    if orientation == 8:
        return np.rot90(pixels)
    return pixels


def _read_pixels(path: Path, colour_space: str) -> tuple[np.ndarray, str]:
    hints = oiio.ImageSpec()
    hints.attribute("oiio:UnassociatedAlpha", 1)
    image = oiio.ImageInput.open(str(path), hints)
    if image is None:
        oiio.geterror()
        raise ValueError(
            "Could not decode the panorama. Check that the file is complete and valid."
        )
    try:
        if image.format_name() != _FORMATS[path.suffix]:
            raise ValueError("Image contents do not match the filename format")
        spec = image.spec()
        _dimensions(spec.width, spec.height)
        _dimensions(spec.full_width, spec.full_height)
        if spec.deep or spec.depth != 1:
            raise ValueError(
                "Use a flat RGB panorama, rather than a deep or volume image"
            )
        width, height = spec.full_width, spec.full_height
        if spec.get_int_attribute("Orientation", 1) in (5, 6, 7, 8):
            width, height = height, width
        if abs(width / height - 2) > 0.02:
            raise ValueError(
                "Use a 2:1 equirectangular panorama (for example, 2048 × 1024)"
            )
        names = [name.lower() for name in spec.channelnames]
        if all(name in names for name in ("r", "g", "b")):
            channels = [names.index(name) for name in ("r", "g", "b")]
        elif spec.nchannels in (1, 2) and names[0] in (
            "y",
            "l",
            "luminance",
            "gray",
            "grey",
        ):
            channels = [0, 0, 0]
        else:
            raise ValueError(
                "The first image must contain RGB or grayscale colour channels"
            )
        selected = channels + ([spec.alpha_channel] if spec.alpha_channel >= 0 else [])
        first, last = min(selected), max(selected) + 1
        if last - first > 4:
            raise ValueError(
                "Use an RGB/RGBA image with colour channels grouped together"
            )
        pixels = image.read_image(0, 0, first, last, oiio.FLOAT)
        if pixels is None:
            raise ValueError(
                "Could not read panorama pixels. The file may be truncated or unsupported."
            )
    finally:
        image.geterror()
        image.close()
        oiio.geterror()

    if not np.isfinite(pixels).all():
        raise ValueError(
            "Panorama colour and alpha channels must not contain NaN or infinity"
        )
    rgb = pixels[:, :, [channel - first for channel in channels]].copy()
    alpha = None
    if spec.alpha_channel >= 0:
        alpha = pixels[
            :, :, spec.alpha_channel - first : spec.alpha_channel - first + 1
        ]
        # OIIO leaves straight alpha intact on request; EXR normally uses associated alpha.
        if not spec.get_int_attribute("oiio:UnassociatedAlpha", 0):
            np.divide(rgb, alpha, out=rgb, where=alpha > 0)
        rgb[alpha[:, :, 0] <= 0] = 0

    if colour_space == "auto":
        source_space = spec.get_string_attribute("oiio:ColorSpace")
        # PFM's plugin reports Rec709 even though PFM stores linear radiance.
        if path.suffix == ".pfm":
            source_space = "lin_rec709_scene"
        if not source_space:
            floating = spec.format.basetype in (oiio.HALF, oiio.FLOAT, oiio.DOUBLE)
            source_space = (
                "lin_rec709_scene"
                if floating or path.suffix == ".exr"
                else "srgb_rec709_scene"
            )
    else:
        source_space = _COLOUR_SPACES[colour_space]
    if source_space.lower() in (
        "srgb",
        "srgb_rec709_scene",
        "srgb encoded rec.709 (srgb)",
    ):
        # Match the exact sRGB transfer used by the browser, without an OCIO LUT.
        rgb = np.where(
            rgb <= 0.04045, rgb / 12.92, ((np.maximum(rgb, 0) + 0.055) / 1.055) ** 2.4
        )
    elif source_space.lower() not in (
        "linear",
        "lin_rec709_scene",
        "linear rec.709 (srgb)",
    ):
        converted = oiio.ImageBufAlgo.colorconvert(
            oiio.ImageBuf(rgb), source_space, "lin_rec709_scene"
        )
        if converted.has_error:
            converted.geterror()
            raise ValueError(
                "Unknown source colour space. Choose the panorama's source colour space explicitly."
            )
        rgb = converted.get_pixels(oiio.FLOAT)
    if rgb is None or not np.isfinite(rgb).all():
        raise ValueError("Panorama colour conversion produced non-finite values")
    np.maximum(rgb, 0, out=rgb)
    if alpha is not None:
        rgb *= np.clip(alpha, 0, 1)
    # Restore EXR's display window: cropped-away regions contain no radiance.
    if (spec.x, spec.y, spec.width, spec.height) != (
        spec.full_x,
        spec.full_y,
        spec.full_width,
        spec.full_height,
    ):
        full = np.zeros((spec.full_height, spec.full_width, 3), dtype=np.float32)
        x0, y0 = max(spec.x, spec.full_x), max(spec.y, spec.full_y)
        x1 = min(spec.x + spec.width, spec.full_x + spec.full_width)
        y1 = min(spec.y + spec.height, spec.full_y + spec.full_height)
        if x1 > x0 and y1 > y0:
            full[
                y0 - spec.full_y : y1 - spec.full_y, x0 - spec.full_x : x1 - spec.full_x
            ] = rgb[y0 - spec.y : y1 - spec.y, x0 - spec.x : x1 - spec.x]
        rgb = full
    rgb = _orient(rgb, spec.get_int_attribute("Orientation", 1))
    height, width = rgb.shape[:2]
    if abs(width / height - 2) > 0.02:
        raise ValueError(
            "Use a 2:1 equirectangular panorama (for example, 2048 × 1024)"
        )
    return rgb, source_space


def _integrate(rgb: np.ndarray) -> dict[str, object]:
    height, width = rgb.shape[:2]
    peak = float(rgb.max())
    columns = np.zeros((_LIGHTS_PER_ARC, width, 3), dtype=np.float64)
    step = 2 * _MAX_ELEVATION / (_LIGHTS_PER_ARC - 1)
    for row in range(_LIGHTS_PER_ARC):
        upper = math.pi / 2 if row == 0 else _MAX_ELEVATION - (row - 0.5) * step
        lower = (
            -math.pi / 2
            if row == _LIGHTS_PER_ARC - 1
            else _MAX_ELEVATION - (row + 0.5) * step
        )
        area = math.sin(upper) - math.sin(lower)
        first_y = max(0, math.floor((0.5 - upper / math.pi) * height))
        last_y = min(height, math.ceil((0.5 - lower / math.pi) * height))
        light = row // 2 if row % 2 == 0 else 7 + (row - 1) // 2
        # Accumulate one scanline at a time, bounding temporary memory for 8K maps.
        for y in range(first_y, last_y):
            pixel_upper = (0.5 - y / height) * math.pi
            pixel_lower = (0.5 - (y + 1) / height) * math.pi
            weight = (
                math.sin(min(upper, pixel_upper)) - math.sin(max(lower, pixel_lower))
            ) / area
            columns[light] += rgb[y].astype(np.float64) * weight
    # A Reinhard/sRGB thumbnail is for display only; lighting uses the source peak.
    rows = np.minimum((np.arange(128) + 0.5) * height / 128, height - 1).astype(int)
    cols = np.minimum((np.arange(256) + 0.5) * width / 256, width - 1).astype(int)
    display = rgb[rows[:, None], cols].astype(np.float64)
    display /= 1 + display
    display = np.where(
        display <= 0.0031308, display * 12.92, 1.055 * display ** (1 / 2.4) - 0.055
    )
    thumbnail = np.full((128, 256, 4), 255, dtype=np.uint8)
    thumbnail[:, :, :3] = np.rint(np.clip(display, 0, 1) * 255).astype(np.uint8)
    return {
        "width": width,
        "height": height,
        "lightsPerArc": _LIGHTS_PER_ARC,
        "peak": peak,
        "columns": columns.ravel().tolist(),
        "thumbnail": {"width": 256, "height": 128, "data": thumbnail.ravel().tolist()},
    }


def decode_environment(
    payload: bytes, filename: str, colour_space: str = "auto"
) -> dict[str, object]:
    """Decode an uploaded image using a private temporary file, removed on return."""
    suffix = Path(filename.lower()).suffix
    if suffix not in _FORMATS:
        raise ValueError("Choose HDR/RGBE, EXR, TIFF, PFM, PNG, JPEG or WebP")
    if colour_space not in ("auto", *_COLOUR_SPACES):
        raise ValueError("Unsupported source colour space")
    if not 0 < len(payload) <= MAX_ENVIRONMENT_BYTES:
        raise ValueError("Environment image must be between 1 byte and 64 MiB")
    with TemporaryDirectory(prefix="lswebui-ibl-") as directory:
        path = Path(directory) / f"panorama{suffix}"
        path.write_bytes(payload)
        rgb, source_space = _read_pixels(path, colour_space)
    result = _integrate(rgb)
    result["sourceColourSpace"] = source_space
    return result
