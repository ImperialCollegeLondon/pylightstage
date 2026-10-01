import { importEnvironment } from "./api.js";
import { EnvironmentMap } from "./environment-map.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;

/** Standard images stay browser-local; professional images use the local decoder. */
export async function decodeEnvironmentImage(source, lightsPerArc, colourSpace = "auto") {
  const extension = source.name.split(".").pop().toLowerCase();
  if (!["png", "jpg", "jpeg", "webp", "hdr", "rgbe", "exr", "tif", "tiff", "pfm"].includes(extension)
      || source.size < 1 || source.size > MAX_BYTES) {
    throw new Error("Choose HDR/RGBE, EXR, TIFF, PFM, PNG, JPEG or WebP up to 64 MiB.");
  }
  // Canvas decoding would quantize a 16-bit PNG to 8-bit sRGB.
  const highBitPNG = extension === "png"
    && new Uint8Array(await source.slice(0, 29).arrayBuffer())[24] === 16;
  if (!["png", "jpg", "jpeg", "webp"].includes(extension) || highBitPNG || colourSpace !== "auto") {
    const result = await importEnvironment(source, colourSpace);
    const environment = EnvironmentMap.fromIntegrated(result, lightsPerArc);
    const thumb = result.thumbnail;
    if (!thumb || thumb.width !== 256 || thumb.height !== 128
        || !Array.isArray(thumb.data) || thumb.data.length !== 256 * 128 * 4
        || !thumb.data.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      throw new Error("Environment import returned an invalid thumbnail");
    }
    return {
      environment,
      thumbnail: new ImageData(Uint8ClampedArray.from(thumb.data), thumb.width, thumb.height),
    };
  }
  const bitmap = await createImageBitmap(source);
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS || Math.max(bitmap.width, bitmap.height) > 16384) {
      throw new Error("Panorama must not exceed 32 MiPixels or 16384 pixels per dimension.");
    }
    if (Math.abs(bitmap.width / bitmap.height - 2) > 0.02) {
      throw new Error("Use a 2:1 equirectangular panorama (for example, 2048 × 1024).");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const environment = new EnvironmentMap(context.getImageData(0, 0, canvas.width, canvas.height), lightsPerArc);
    canvas.width = 256;
    canvas.height = 128;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { environment, thumbnail: context.getImageData(0, 0, 256, 128) };
  } finally {
    bitmap.close();
  }
}
