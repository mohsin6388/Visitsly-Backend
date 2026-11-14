const tenantContext = require('../context/tenantContext');

/**
 * Wraps async route handlers so rejected promises are forwarded to
 * Express's error middleware instead of crashing the process.
 *
 * Also re-enters the company's tenant context: some middlewares (multer
 * uploads) resume on stream events that lose the AsyncLocalStorage store,
 * so the handler would otherwise run without knowing its tenant.
 */
const asyncHandler = (fn) => (req, res, next) => {
  const exec = () => Promise.resolve(fn(req, res, next)).catch(next);
  if (req.org && tenantContext.getOrg()?._id !== req.org._id) {
    return tenantContext.run(req.org, exec);
  }
  return exec();
};

module.exports = asyncHandler;
