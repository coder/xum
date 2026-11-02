import { createRequire } from "node:module";
import type sharp from "sharp";
// sharp 0.35 types are ES modules: Metadata is a named export, not on the default namespace.
import type { Metadata } from "sharp";
import { MAX_IMAGE_DIMENSION, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import {
  computeResizedDimensions,
  getResizedRasterOutputMediaType,
} from "@/common/utils/attachments/rasterImageResize";
import { normalizeAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import assert from "@/common/utils/assert";

export interface ResizedRasterImageAttachmentResult {
  data: Buffer;
  mediaType: string;
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

export interface ResizedRasterImageAttachmentBase64Result {
  data: string;
  mediaType: string;
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

export function isRasterAttachmentMediaType(mediaType: string): boolean {
  const normalizedMediaType = normalizeAttachmentMediaType(mediaType);
  return normalizedMediaType.startsWith("image/") && normalizedMediaType !== SVG_MEDIA_TYPE;
}

type SharpModule = typeof sharp;

const requireSharp = createRequire(__filename);
let sharpModule: SharpModule | undefined;

function getSharp(): SharpModule {
  // Lazy-load sharp so CLI startup and lockfile-free bench-agent checks do not require
  // the native image pipeline unless we actually process a raster attachment.
  sharpModule ??= requireSharp("sharp") as SharpModule;
  return sharpModule;
}

export function orientationSwapsDimensions(orientation: number | undefined): boolean {
  return orientation != null && orientation >= 5 && orientation <= 8;
}

export function getRasterImageDimensionsFromMetadata(metadata: Metadata): {
  width: number;
  height: number;
} | null {
  if (
    metadata.width == null ||
    metadata.width <= 0 ||
    metadata.height == null ||
    metadata.height <= 0
  ) {
    return null;
  }

  return orientationSwapsDimensions(metadata.orientation)
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

async function getImageDimensions(data: Buffer): Promise<{ width: number; height: number }> {
  const sharp = getSharp();
  const dimensions = getRasterImageDimensionsFromMetadata(await sharp(data).metadata());
  assert(dimensions != null, "Failed to read image dimensions from attachment");
  return dimensions;
}

export async function resizeRasterImageAttachmentBufferIfNeeded(
  data: Buffer,
  mediaType: string,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<ResizedRasterImageAttachmentResult> {
  assert(data.length > 0, "Expected raster attachment bytes");

  const normalizedMediaType = normalizeAttachmentMediaType(mediaType);
  assert(
    isRasterAttachmentMediaType(normalizedMediaType),
    `Expected a raster image attachment, got '${mediaType}'`
  );

  const { width: originalWidth, height: originalHeight } = await getImageDimensions(data);
  const resizedDimensions = computeResizedDimensions(originalWidth, originalHeight, maxDimension);
  if (resizedDimensions == null) {
    return {
      data,
      mediaType: normalizedMediaType,
      resized: false,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
    };
  }

  const outputMediaType = getResizedRasterOutputMediaType(normalizedMediaType);
  const sharp = getSharp();
  const resizedPipeline = sharp(data).rotate().resize({
    width: resizedDimensions.width,
    height: resizedDimensions.height,
    fit: "fill",
  });
  const resizedData =
    outputMediaType === "image/jpeg"
      ? await resizedPipeline.jpeg({ quality: 90 }).toBuffer()
      : await resizedPipeline.png().toBuffer();
  assert(resizedData.length > 0, "Expected resized raster attachment bytes");

  return {
    data: resizedData,
    mediaType: outputMediaType,
    resized: true,
    originalWidth,
    originalHeight,
    width: resizedDimensions.width,
    height: resizedDimensions.height,
  };
}

export async function resizeRasterImageAttachmentBase64IfNeeded(
  data: string,
  mediaType: string,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<ResizedRasterImageAttachmentBase64Result> {
  assert(data.trim().length > 0, "Expected raster attachment base64 data");

  const decodedBytes = Buffer.from(data, "base64");
  assert(decodedBytes.length > 0, "Expected decoded raster attachment bytes");

  const resized = await resizeRasterImageAttachmentBufferIfNeeded(
    decodedBytes,
    mediaType,
    maxDimension
  );

  return {
    data: resized.data.toString("base64"),
    mediaType: resized.mediaType,
    resized: resized.resized,
    originalWidth: resized.originalWidth,
    originalHeight: resized.originalHeight,
    width: resized.width,
    height: resized.height,
  };
}
