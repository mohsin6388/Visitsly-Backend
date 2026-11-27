const cloudinary = require("../config/cloudinary");
const streamifier = require("streamifier");
const logger = require("../utils/logger");

function uploadBufferToCloudinary(
  buffer,
  { folder = "properties", resourceType = "auto", publicId, filename } = {},
) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        ...(publicId ? { public_id: publicId } : {}),
        ...(filename ? { filename_override: filename, use_filename: true, unique_filename: true } : {}),
      },
      (error, result) => {
        if (error) {
          logger.error("[cloudinary] upload failed", { status: error.http_code, error: error.message });
          return reject(error);
        }
        resolve(result);
      },
    );
    uploadStream.on("error", (streamError) => {
      logger.error("[cloudinary] upload stream failed", { error: streamError.message });
      reject(streamError);
    });
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

module.exports = { uploadBufferToCloudinary, isCloudinaryConfigured: () => cloudinary.isConfigured() };
