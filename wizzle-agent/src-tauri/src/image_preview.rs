use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, ColorType, DynamicImage, GenericImageView,
    ImageDecoder, ImageFormat, ImageReader, Limits, Rgb, RgbImage,
};

pub const MAX_INLINE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SOURCE_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 1600;
const MAX_SOURCE_IMAGE_DIMENSION: u32 = 16_384;
const MAX_DECODED_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
const MIN_IMAGE_DIMENSION: u32 = 512;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];

pub struct InlineImagePayload {
    pub image_src: String,
    pub mime_type: String,
}

pub fn file_extension(path_or_name: &str) -> String {
    std::path::Path::new(path_or_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default()
}

pub fn is_supported_image_extension(extension: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&extension)
}

pub fn build_inline_image_payload(
    path_or_name: &str,
    bytes: &[u8],
) -> Result<Option<InlineImagePayload>, String> {
    let extension = file_extension(path_or_name);

    if !is_supported_image_extension(&extension) {
        return Ok(None);
    }

    if bytes.len() > MAX_SOURCE_IMAGE_BYTES {
        return Err(format!(
            "{} is larger than {} MB and cannot be opened as an inline image preview.",
            file_name(path_or_name),
            MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)
        ));
    }

    let (mime_type, encoded_bytes) = if should_keep_original_image(&extension, bytes.len()) {
        (infer_image_mime(&extension).to_string(), bytes.to_vec())
    } else {
        process_raster_image(bytes, &extension)?
    };

    if encoded_bytes.len() > MAX_INLINE_IMAGE_BYTES {
        return Err(format!(
            "{} is too large to attach as an inline image preview.",
            file_name(path_or_name)
        ));
    }

    Ok(Some(InlineImagePayload {
        image_src: format!("data:{mime_type};base64,{}", STANDARD.encode(encoded_bytes)),
        mime_type,
    }))
}

fn should_keep_original_image(extension: &str, byte_len: usize) -> bool {
    matches!(extension, "gif" | "svg") && byte_len <= MAX_INLINE_IMAGE_BYTES
}

fn process_raster_image(bytes: &[u8], extension: &str) -> Result<(String, Vec<u8>), String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Could not identify image preview: {error}"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Could not create image preview decoder: {error}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_SOURCE_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODED_IMAGE_BYTES);
    decoder
        .set_limits(limits)
        .map_err(|error| format!("Image preview exceeds safe decode limits: {error}"))?;
    let decoded = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Could not decode image preview: {error}"))?;
    let has_alpha = decoded.color().has_alpha();
    let target_max_dimensions = target_dimensions(&decoded);
    let quality_steps = [82_u8, 72, 62, 52];

    for max_dimension in target_max_dimensions {
        let candidate = resize_to_fit(&decoded, max_dimension);

        if has_alpha {
            let png_bytes = encode_png(&candidate)
                .map_err(|error| format!("Could not encode PNG preview: {error}"))?;
            if png_bytes.len() <= MAX_INLINE_IMAGE_BYTES {
                return Ok(("image/png".to_string(), png_bytes));
            }
        }

        for quality in quality_steps {
            let jpeg_bytes = encode_jpeg_with_white_background(&candidate, quality)
                .map_err(|error| format!("Could not encode JPEG preview: {error}"))?;
            if jpeg_bytes.len() <= MAX_INLINE_IMAGE_BYTES {
                return Ok(("image/jpeg".to_string(), jpeg_bytes));
            }
        }
    }

    if bytes.len() <= MAX_INLINE_IMAGE_BYTES {
        return Ok((infer_image_mime(extension).to_string(), bytes.to_vec()));
    }

    Err("The image could not be reduced enough for inline previewing.".to_string())
}

fn target_dimensions(image: &DynamicImage) -> Vec<u32> {
    let longest_edge = image.width().max(image.height());
    let mut dimensions = Vec::new();
    let mut current = longest_edge.min(MAX_IMAGE_DIMENSION);

    while current >= MIN_IMAGE_DIMENSION {
        if dimensions.last().copied() != Some(current) {
            dimensions.push(current);
        }

        if current == MIN_IMAGE_DIMENSION {
            break;
        }

        current = ((current as f32) * 0.8).round() as u32;
        if current < MIN_IMAGE_DIMENSION {
            current = MIN_IMAGE_DIMENSION;
        }
    }

    if dimensions.is_empty() {
        dimensions.push(MAX_IMAGE_DIMENSION);
    }

    dimensions
}

fn resize_to_fit(image: &DynamicImage, max_dimension: u32) -> DynamicImage {
    let (width, height) = image.dimensions();

    if width.max(height) <= max_dimension {
        return image.clone();
    }

    image.resize(max_dimension, max_dimension, FilterType::Lanczos3)
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, image::ImageError> {
    let mut cursor = Cursor::new(Vec::new());
    image.write_to(&mut cursor, ImageFormat::Png)?;
    Ok(cursor.into_inner())
}

fn encode_jpeg_with_white_background(
    image: &DynamicImage,
    quality: u8,
) -> Result<Vec<u8>, image::ImageError> {
    let rgb = flatten_to_white_background(image);
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
    encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ColorType::Rgb8.into(),
    )?;
    Ok(bytes)
}

fn flatten_to_white_background(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());

    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = f32::from(pixel[3]) / 255.0;
        let red = ((f32::from(pixel[0]) * alpha) + (255.0 * (1.0 - alpha))).round() as u8;
        let green = ((f32::from(pixel[1]) * alpha) + (255.0 * (1.0 - alpha))).round() as u8;
        let blue = ((f32::from(pixel[2]) * alpha) + (255.0 * (1.0 - alpha))).round() as u8;

        rgb.put_pixel(x, y, Rgb([red, green, blue]));
    }

    rgb
}

pub fn infer_image_mime(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "image/png",
    }
}

pub fn file_name(path_or_name: &str) -> String {
    std::path::Path::new(path_or_name)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "image".to_string())
}
