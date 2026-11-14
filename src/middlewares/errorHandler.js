const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const env = require('../config/env');

/**
 * Central error-handling middleware. Every thrown/next(err) call in the app
 * ends up here. Normalizes known error types (ApiError, Mongoose validation/
 * cast/duplicate-key errors, JWT errors) into a consistent JSON shape and
 * never leaks stack traces in production.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return req.socket?.destroy?.();
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details || null;

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for field "${err.path}"`;
  }

  // Upload errors (multer)
  if (err.name === 'MulterError') {
    statusCode = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File bahut badi hai. Chhoti file chunein.' : 'File upload nahi hui. Dobara try karein.';
  }

  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Request ka data sahi format mein nahi hai.';
  }
  if (err.type === 'entity.too.large') {
    statusCode = 413;
    message = 'Data bahut bada hai. Chhote hisson mein bhejein.';
  }

  // Mongo duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyPattern || {}).join(', ');
    message = `Duplicate value for field: ${field}`;
  }

  if (!(err instanceof ApiError) && statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${err.message}`, { stack: err.stack });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${statusCode} ${message}`);
  }

  // Never leak internal error text to users in production.
  if (statusCode >= 500 && !(err instanceof ApiError) && env.nodeEnv === 'production') {
    message = 'Server par kuch gadbad ho gayi. Thodi der baad dobara try karein.';
  }

  res.status(statusCode).json({
    success: false,
    message,
    details,
    ...(env.nodeEnv !== 'production' && { stack: err.stack }),
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

module.exports = { errorHandler, notFoundHandler };
