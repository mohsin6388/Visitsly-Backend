const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const { buildReport } = require('../services/reports/reportsService');

/** GET /api/reports?range=7d|30d|90d|this_month|last_month */
const getReport = asyncHandler(async (req, res) => {
  const range = ['7d', '30d', '90d', 'this_month', 'last_month'].includes(req.query.range) ? req.query.range : '30d';
  const report = await buildReport(req.user.id, req.org?._id, range);
  const org = req.org;
  return new ApiResponse(200, { report, weeklyReport: org?.weeklyReport || null }).send(res);
});

module.exports = { getReport };
