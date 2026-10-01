"""Exercise actual native codecs and linear-radiance imports without hardware."""

import math
from pathlib import Path

import numpy as np
import OpenImageIO as oiio
import pytest

from pylightstage.lswebui import environment_files as images

pytestmark = pytest.mark.unit


def write_image(
    tmp_path, extension, pixels, pixel_type=oiio.FLOAT, channel_names=None, **attributes
):
    path = tmp_path / f"panorama.{extension}"
    height, width, channels = pixels.shape
    spec = oiio.ImageSpec(width, height, channels, pixel_type)
    if channel_names is not None:
        spec.channelnames = channel_names
    for name, value in attributes.items():
        spec.attribute(name, value)
    output = oiio.ImageOutput.create(str(path))
    assert output.open(str(path), spec), output.geterror()
    assert output.write_image(pixels), output.geterror()
    assert output.close(), output.geterror()
    return path


@pytest.mark.parametrize("extension", ["hdr", "rgbe", "exr", "tif", "tiff", "pfm"])
def test_real_hdr_codecs_preserve_values_above_one(tmp_path, extension):
    pixels = np.full((16, 32, 3), [4, 2, 1], dtype=np.float32)
    path = write_image(tmp_path, extension, pixels)
    result = images.decode_environment(path.read_bytes(), path.name)
    assert result["peak"] == 4
    columns = np.array(result["columns"]).reshape(14, 32, 3)
    np.testing.assert_allclose(columns, np.broadcast_to([4, 2, 1], columns.shape))
    assert result["width"] == 32 and result["height"] == 16
    # The thumbnail is tone-mapped; it cannot be the source of these integrals.
    assert max(result["thumbnail"]["data"]) <= 255
    assert result["sourceColourSpace"] == "lin_rec709_scene"


@pytest.mark.parametrize("compression", ["none", "zip", "piz", "rle"])
@pytest.mark.parametrize("pixel_type", [oiio.HALF, oiio.FLOAT])
def test_compressed_exr_half_and_float(tmp_path, compression, pixel_type):
    pixels = np.full((4, 8, 3), [16, 4, 0.25], dtype=np.float32)
    path = write_image(tmp_path, "exr", pixels, pixel_type, compression=compression)
    result = images.decode_environment(path.read_bytes(), path.name)
    assert result["peak"] == 16
    assert result["columns"][:3] == pytest.approx([16, 4, 0.25])


def test_tiled_exr_is_decoded(tmp_path):
    path = tmp_path / "tiled.exr"
    spec = oiio.ImageSpec(32, 16, 3, oiio.HALF)
    spec.tile_width = spec.tile_height = 16
    spec.attribute("compression", "piz")
    output = oiio.ImageOutput.create(str(path))
    assert output.open(str(path), spec)
    assert output.write_image(np.full((16, 32, 3), [8, 2, 1], dtype=np.float32))
    assert output.close()
    result = images.decode_environment(path.read_bytes(), path.name)
    assert result["columns"][:3] == pytest.approx([8, 2, 1])


@pytest.mark.parametrize("extension", ["png", "tif"])
def test_16_bit_images_are_not_quantized_to_8_bit(tmp_path, extension):
    pixels = np.full((2, 4, 3), [30001, 12001, 1001], dtype=np.uint16)
    path = write_image(tmp_path, extension, pixels, oiio.UINT16)
    result = images.decode_environment(path.read_bytes(), path.name)
    normalized = np.array([30001, 12001, 1001]) / 65535
    expected = np.where(
        normalized <= 0.04045, normalized / 12.92, ((normalized + 0.055) / 1.055) ** 2.4
    )
    assert result["columns"][:3] == pytest.approx(expected, rel=1e-4)
    assert result["peak"] == pytest.approx(expected[0], rel=1e-4)
    # One 16-bit step matters even where it would be rounded away by Canvas.
    assert abs(result["columns"][0] - ((30000 / 65535 + 0.055) / 1.055) ** 2.4) > 1e-6


def test_pfm_orientation_and_fractional_solid_angles(tmp_path):
    pixels = np.zeros((5, 10, 3), dtype=np.float32)
    for y in range(5):
        pixels[y, :, 0] = 2 + y
    path = write_image(tmp_path, "pfm", pixels)
    result = images.decode_environment(path.read_bytes(), path.name)
    columns = np.array(result["columns"]).reshape(14, 10, 3)
    assert columns[0, 0, 0] == pytest.approx(2)
    assert columns[13, 0, 0] == pytest.approx(6)
    # Integrating all fixture latitude areas recovers the source sphere integral.
    actual = expected = 0
    step = 2 * 1.08 / 13
    for row, light in enumerate([0, 7, 1, 8, 2, 9, 3, 10, 4, 11, 5, 12, 6, 13]):
        top = math.pi / 2 if row == 0 else 1.08 - (row - 0.5) * step
        bottom = -math.pi / 2 if row == 13 else 1.08 - (row + 0.5) * step
        actual += columns[light, 0, 0] * (math.sin(top) - math.sin(bottom))
    for y in range(5):
        expected += (2 + y) * (
            math.cos(y * math.pi / 5) - math.cos((y + 1) * math.pi / 5)
        )
    assert actual == pytest.approx(expected)


@pytest.mark.parametrize("extension,straight", [("exr", False), ("tif", True)])
def test_alpha_is_applied_once_and_transparent_pixels_do_not_set_peak(
    tmp_path, extension, straight
):
    pixels = np.array([[[1, 0.5, 0.25, 0.5], [1000, 1000, 1000, 0]]], dtype=np.float32)
    path = write_image(
        tmp_path,
        extension,
        pixels,
        **{
            "oiio:UnassociatedAlpha": int(straight),
            "oiio:ColorSpace": "linear",
        },
    )
    result = images.decode_environment(path.read_bytes(), path.name)
    scale = 0.5 if straight else 1
    assert result["peak"] == scale
    assert result["columns"][:6] == pytest.approx(
        [scale, scale / 2, scale / 4, 0, 0, 0]
    )


def test_acescg_metadata_and_explicit_override(tmp_path):
    pixels = np.full((2, 4, 3), [4, 2, 1], dtype=np.float32)
    path = write_image(tmp_path, "exr", pixels, **{"oiio:ColorSpace": "ACEScg"})
    auto = images.decode_environment(path.read_bytes(), path.name)
    aces = images.decode_environment(path.read_bytes(), path.name, "acescg")
    linear = images.decode_environment(path.read_bytes(), path.name, "linear")
    assert auto["columns"] == pytest.approx(aces["columns"])
    assert auto["peak"] == pytest.approx(5.49336, rel=1e-4)
    assert auto["columns"][:3] == pytest.approx([5.49336, 1.750036, 0.799021], rel=1e-4)
    assert linear["peak"] == 4
    assert linear["columns"][:3] == pytest.approx([4, 2, 1])


def test_cropped_exr_restores_display_window(tmp_path):
    path = tmp_path / "cropped.exr"
    spec = oiio.ImageSpec(4, 2, 3, oiio.FLOAT)
    spec.x, spec.y = 2, 1
    spec.full_width, spec.full_height = 8, 4
    output = oiio.ImageOutput.create(str(path))
    assert output.open(str(path), spec)
    assert output.write_image(np.full((2, 4, 3), [4, 2, 1], dtype=np.float32))
    assert output.close()
    result = images.decode_environment(path.read_bytes(), path.name)
    assert (result["width"], result["height"]) == (8, 4)
    columns = np.array(result["columns"]).reshape(14, 8, 3)
    assert not columns[:, :2].any() and not columns[:, 6:].any()
    assert not columns[0].any() and not columns[13].any()
    assert result["peak"] == 4


def test_tiff_display_orientation(tmp_path):
    pixels = np.zeros((8, 4, 3), dtype=np.float32)
    pixels[:, :2, 0] = 4
    pixels[:, 2:, 2] = 4
    path = write_image(tmp_path, "tif", pixels, Orientation=6)
    result = images.decode_environment(path.read_bytes(), path.name)
    assert (result["width"], result["height"]) == (8, 4)
    assert result["columns"][:3] == pytest.approx([4, 0, 0])
    assert result["columns"][-3:] == pytest.approx([0, 0, 4])


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_non_finite_radiance_is_rejected(tmp_path, value):
    path = write_image(
        tmp_path, "exr", np.full((1, 2, 3), [value, 1, 0], dtype=np.float32)
    )
    with pytest.raises(ValueError, match="NaN or infinity"):
        images.decode_environment(path.read_bytes(), path.name)


def test_black_and_negative_radiance_are_finite(tmp_path):
    path = write_image(
        tmp_path, "exr", np.full((1, 2, 3), [-2, 0, 0], dtype=np.float32)
    )
    result = images.decode_environment(path.read_bytes(), path.name)
    assert result["peak"] == 0 and not any(result["columns"])


def test_invalid_format_colour_space_and_truncated_images_are_rejected(tmp_path):
    path = write_image(tmp_path, "exr", np.ones((1, 2, 3), dtype=np.float32))
    for payload, name, colour_space in [
        (b"broken", "bad.exr", "auto"),
        (b"", "bad.hdr", "auto"),
        (path.read_bytes(), "bad.xyz", "auto"),
        (path.read_bytes(), "bad.hdr", "auto"),
        (path.read_bytes(), "good.exr", "unknown"),
    ]:
        with pytest.raises(ValueError):
            images.decode_environment(payload, name, colour_space)


def test_dimensions_are_bounded_before_reading_pixels(tmp_path, monkeypatch):
    path = write_image(tmp_path, "exr", np.ones((2, 4, 3), dtype=np.float32))
    monkeypatch.setattr(images, "MAX_ENVIRONMENT_PIXELS", 4)
    with pytest.raises(ValueError, match="MiPixels"):
        images.decode_environment(path.read_bytes(), path.name)


def test_non_panorama_is_rejected(tmp_path):
    path = write_image(tmp_path, "exr", np.ones((2, 2, 3), dtype=np.float32))
    with pytest.raises(ValueError, match="2:1"):
        images.decode_environment(path.read_bytes(), path.name)


def test_grayscale_pfm_is_replicated_to_rgb(tmp_path):
    path = write_image(tmp_path, "pfm", np.full((1, 2, 1), 4, dtype=np.float32))
    result = images.decode_environment(path.read_bytes(), path.name)
    assert result["peak"] == 4
    assert result["columns"][:3] == pytest.approx([4, 4, 4])


def test_auxiliary_only_exr_is_not_treated_as_grayscale_colour(tmp_path):
    path = write_image(
        tmp_path, "exr", np.full((1, 2, 1), 4, dtype=np.float32), channel_names=["Z"]
    )
    with pytest.raises(ValueError, match="colour channels"):
        images.decode_environment(path.read_bytes(), path.name)


def test_temporary_file_is_deleted_even_when_decoding_fails(monkeypatch):
    seen = []

    def fail(path, colour_space):
        seen.append(Path(path))
        assert path.is_file()
        raise ValueError("broken file")

    monkeypatch.setattr(images, "_read_pixels", fail)
    with pytest.raises(ValueError, match="broken file"):
        images.decode_environment(b"broken", "../../bad.exr")
    assert not seen[0].exists() and not seen[0].parent.exists()
