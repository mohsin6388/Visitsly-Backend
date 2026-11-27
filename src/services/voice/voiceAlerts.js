const Organization = require('../../models/Organization');
const Notification = require('../../models/Notification');
const orgService = require('../saas/orgService');
const logger = require('../../utils/logger');

/**
 * In-app owner alerts for AI calling minutes: once when 80% of this month's
 * minutes are used and once when none are left (each at most once per month).
 * Best effort — never throws, never blocks a call from being finalized.
 */
const WARN_AT = 0.8;

async function claim(orgId, month, flag) {
  // New month → reset both flags, then claim the flag atomically (so two servers never both alert).
  await Organization.updateOne(
    { _id: orgId, 'voiceAlerts.month': { $ne: month } },
    { $set: { 'voiceAlerts.month': month, 'voiceAlerts.warned': false, 'voiceAlerts.exhausted': false } },
  );
  const res = await Organization.updateOne(
    { _id: orgId, 'voiceAlerts.month': month, [`voiceAlerts.${flag}`]: { $ne: true } },
    { $set: { [`voiceAlerts.${flag}`]: true } },
  );
  return Boolean(res.modifiedCount);
}

async function afterBilling(orgId) {
  try {
    const { voiceUsage } = require('../saas/subscription');
    const org = await Organization.findById(orgId)
      .select('ownerUserId plan status usage voicePrepaidUsed addonGrants limitOverrides featureOverrides')
      .lean();
    const u = org && voiceUsage(org);
    if (!u || !u.enabled || u.unlimited) return;
    const pool = u.usedMinutes + u.remainingIncluded; // minutes available to this month's calls
    if (pool <= 0) return;
    const month = orgService.currentMonthIST();
    let kind = null;
    if (u.remainingIncluded <= 0) kind = 'exhausted';
    else if (u.usedMinutes / pool >= WARN_AT) kind = 'warned';
    if (!kind || !(await claim(orgId, month, kind))) return;
    await Notification.create(
      kind === 'exhausted'
        ? { userId: org.ownerUserId, type: 'voice_minutes_finished', title: 'AI calling minutes finished', body: 'Calls are paused. Recharge on the Billing page to continue.', link: '/billing' }
        : { userId: org.ownerUserId, type: 'voice_minutes_low', title: 'AI calling minutes: 80% used', body: `${u.remainingIncluded} min left this month. Recharge on the Billing page to avoid a pause.`, link: '/billing' },
    );
  } catch (err) {
    logger.warn('[voice] minutes alert failed', { error: err.message });
  }
}

module.exports = { afterBilling };
