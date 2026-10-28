const Organization = require('../../models/Organization');
const User = require('../../models/User');
const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Notification = require('../../models/Notification');
const logger = require('../../utils/logger');

/**
 * Round-robin lead assignment. Eligible = the agent list chosen in
 * Settings → Lead routing, or every active agent (then managers) of the company.
 */
async function eligibleUsers(org) {
  const ids = (org.routing?.agentIds || []).map(String);
  if (ids.length) {
    const users = await User.find({ _id: { $in: ids }, orgId: org._id, isActive: true }).select('_id name').lean();
    return ids.map((id) => users.find((u) => String(u._id) === id)).filter(Boolean);
  }
  let users = await User.find({ orgId: org._id, isActive: true, orgRole: 'agent' }).sort({ createdAt: 1 }).select('_id name').lean();
  if (!users.length) users = await User.find({ orgId: org._id, isActive: true, orgRole: 'manager' }).sort({ createdAt: 1 }).select('_id name').lean();
  return users;
}

async function assignLead(lead, user, { notify = true } = {}) {
  await Lead.updateOne({ _id: lead._id }, { $set: { assignedTo: user ? user._id : null, assignedAt: user ? new Date() : null } });
  await Conversation.updateOne({ leadId: lead._id }, { $set: { assignedTo: user ? user._id : null } });
  if (user && notify) {
    await Notification.create({
      userId: lead.ownerId,
      type: 'lead_assigned',
      title: `${lead.name} → ${user.name}`,
      body: `Nayi lead ${user.name} ko assign hui${lead.source ? ` (${lead.source})` : ''}.`,
      link: `/whatsapp/conversations?lead=${lead._id}`,
    }).catch(() => {});
  }
}

/** Assigns using the company's routing rule. Returns the user or null. */
async function autoAssign(orgSnap, lead) {
  if (!orgSnap || orgSnap.routing?.mode !== 'round_robin' || lead.assignedTo) return null;
  const users = await eligibleUsers(orgSnap);
  if (!users.length) return null;
  await Organization.updateOne({ _id: orgSnap._id }, { $inc: { 'routing.lastIndex': 1 } });
  const updated = await Organization.findById(orgSnap._id).select('routing.lastIndex').lean();
  const idx = ((updated?.routing?.lastIndex || 0) % users.length + users.length) % users.length;
  const user = users[idx];
  try {
    await assignLead(lead, user);
  } catch (err) {
    logger.warn('[routing] assign failed', { error: err.message });
    return null;
  }
  return user;
}

module.exports = { autoAssign, assignLead, eligibleUsers };
