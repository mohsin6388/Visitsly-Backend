const ApiError = require('../utils/ApiError');

/**
 * Validates req.{body,query,params} against a Zod schema shaped as
 * z.object({ body: ..., query: ..., params: ... }). Any block the schema
 * doesn't define is left untouched.
 */
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    // Show the first problem in plain words instead of a generic "Validation failed".
    const first = result.error.issues[0];
    const field = String(first?.path?.slice(-1)[0] || '').replace(/([A-Z])/g, ' $1').toLowerCase();
    const generic = /^(required|invalid input|expected .* received .*)$/i.test(first?.message || '');
    const message = !first ? 'Validation failed' : generic ? `${field || 'Field'} sahi se bharein` : first.message;
    return next(ApiError.badRequest(message, details));
  }

  // Overwrite with parsed (and defaulted/coerced) values.
  if (result.data.body) req.body = result.data.body;
  if (result.data.query) req.query = result.data.query;
  if (result.data.params) req.params = result.data.params;

  next();
};

module.exports = validate;
