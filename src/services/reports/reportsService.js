const Lead = require('../../models/Lead');
const Message = require('../../models/Message');
const Meeting = require('../../models/Meeting');
const User = require('../../models/User');
const { LEAD_SCORE, HOT_SCORE } = require('../../config/leadRules');

/**
 * Company reports: funnel, source-wise ROI, team performance and daily trend.
 * Computed in plain queries + JS so it works on any MongoDB-compatible store.
 */
const DAY = 24 * 60 * 60 * 1000;

function rangeFor(range = '30d', now = new Date()) {
  const ist = (d) => new Date(d.getTime() + 330 * 60000);
  const startOfISTDay = (d) => {
    const x = ist(d);
    return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) - 330 * 60000);
  };
  if (range === 'this_month' || range === 'last_month') {
    const x = ist(now);
    const m = range === 'this_month' ? x.getUTCMonth() : x.getUTCMonth() - 1;
    const start = new Date(Date.UTC(x.getUTCFullYear(), m, 1) - 330 * 60000);
    const end = range === 'this_month' ? now : new Date(Date.UTC(x.getUTCFullYear(), m + 1, 1) - 330 * 60000);
    return { start, end, label: range === 'this_month' ? 'Is mahine' : 'Pichhla mahina' };
  }
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range] || 30;
  return { start: startOfISTDay(new Date(now.getTime() - (days - 1) * DAY)), end: now, label: `Pichhle ${days} din` };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

async function buildReport(ownerId, orgId, range = '30d') {
  const { start, end, label } = rangeFor(range);
  const inRange = { $gte: start, $lt: end };

  const newLeads = await Lead.find({ ownerId, createdAt: inRange })
    .select('_id source assignedTo leadScore status bookedAt dealValue createdAt channelPartnerId')
    .lean();
  const allLeadIds = await Lead.distinct('_id', { ownerId });

  const [inboundMsgs, outboundLeadIds, meetings, booked, team] = await Promise.all([
    Message.find({ leadId: { $in: allLeadIds }, direction: 'inbound', sender: 'customer', timestamp: inRange }).select('leadId timestamp').lean(),
    Message.distinct('leadId', { leadId: { $in: allLeadIds }, direction: 'outbound', timestamp: inRange }),
    Meeting.find({ ownerId, createdAt: inRange }).select('leadId status source createdAt').lean(),
    Lead.find({ ownerId, bookedAt: inRange }).select('_id source assignedTo dealValue channelPartnerId').lean(),
    orgId ? User.find({ orgId }).select('_id name orgRole isActive').lean() : [],
  ]);

  const repliedSet = new Set(inboundMsgs.map((m) => String(m.leadId)));
  const visitSet = new Set(meetings.map((m) => String(m.leadId)));
  const visitedSet = new Set(meetings.filter((m) => m.status === 'visited').map((m) => String(m.leadId)));
  const leadInfo = new Map();
  const leadsTouched = await Lead.find({ _id: { $in: [...new Set([...repliedSet, ...visitSet])] } }).select('_id source assignedTo leadScore').lean();
  for (const l of [...newLeads, ...leadsTouched]) leadInfo.set(String(l._id), l);

  const qualified = [...repliedSet].filter((id) => (leadInfo.get(id)?.leadScore || 0) > LEAD_SCORE).length;
  const hot = [...repliedSet].filter((id) => (leadInfo.get(id)?.leadScore || 0) > HOT_SCORE).length;

  const funnel = [
    { key: 'new', label: 'Nayi leads / contacts', value: newLeads.length },
    { key: 'contacted', label: 'Message bheja', value: outboundLeadIds.length },
    { key: 'replied', label: 'Reply aaya', value: repliedSet.size },
    { key: 'qualified', label: `Lead (score > ${LEAD_SCORE})`, value: qualified },
    { key: 'hot', label: `Hot (score > ${HOT_SCORE})`, value: hot },
    { key: 'visits', label: 'Site visit book', value: visitSet.size },
    { key: 'visited', label: 'Visit hua', value: visitedSet.size },
    { key: 'booked', label: 'Booking', value: booked.length },
  ];

  // Source-wise (by the lead's source), counting activity in the range.
  const sources = new Map();
  const bump = (src, field) => {
    const k = src || 'manual';
    if (!sources.has(k)) sources.set(k, { source: k, leads: 0, replied: 0, hot: 0, visits: 0, booked: 0, revenue: 0 });
    sources.get(k)[field] += 1;
  };
  newLeads.forEach((l) => bump(l.source, 'leads'));
  repliedSet.forEach((id) => {
    const l = leadInfo.get(id);
    bump(l?.source, 'replied');
    if ((l?.leadScore || 0) > HOT_SCORE) bump(l?.source, 'hot');
  });
  visitSet.forEach((id) => bump(leadInfo.get(id)?.source, 'visits'));
  booked.forEach((l) => {
    bump(l.source, 'booked');
    sources.get(l.source || 'manual').revenue += l.dealValue || 0;
  });
  const bySource = [...sources.values()].map((s) => ({ ...s, replyRate: pct(s.replied, s.leads), visitRate: pct(s.visits, s.leads) })).sort((a, b) => b.leads - a.leads);

  // Team performance (by assignee).
  const people = new Map(team.map((u) => [String(u._id), { userId: String(u._id), name: u.name, orgRole: u.orgRole, isActive: u.isActive, assigned: 0, replied: 0, hot: 0, visits: 0, visited: 0, booked: 0, revenue: 0 }]));
  const unassigned = { userId: null, name: 'Unassigned', orgRole: null, isActive: true, assigned: 0, replied: 0, hot: 0, visits: 0, visited: 0, booked: 0, revenue: 0 };
  const row = (l) => (l?.assignedTo && people.get(String(l.assignedTo))) || unassigned;
  newLeads.forEach((l) => { row(l).assigned += 1; });
  repliedSet.forEach((id) => {
    const l = leadInfo.get(id);
    row(l).replied += 1;
    if ((l?.leadScore || 0) > HOT_SCORE) row(l).hot += 1;
  });
  visitSet.forEach((id) => { row(leadInfo.get(id)).visits += 1; });
  visitedSet.forEach((id) => { row(leadInfo.get(id)).visited += 1; });
  booked.forEach((l) => { row(l).booked += 1; row(l).revenue += l.dealValue || 0; });
  const byAgent = [...people.values(), unassigned]
    .filter((p) => p.isActive || p.assigned || p.booked)
    .filter((p) => p.userId || p.assigned || p.replied || p.visits)
    .map((p) => ({ ...p, conversion: pct(p.visits, p.assigned) }))
    .sort((a, b) => b.booked - a.booked || b.visits - a.visits || b.assigned - a.assigned);

  // Daily trend.
  const days = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY) {
    const key = new Date(t + 330 * 60000).toISOString().slice(0, 10);
    days.push({ date: key, leads: 0, replies: 0, visits: 0 });
  }
  const dayIdx = (d) => days.findIndex((x) => x.date === new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10));
  newLeads.forEach((l) => { const i = dayIdx(l.createdAt); if (i >= 0) days[i].leads += 1; });
  inboundMsgs.forEach((m) => { const i = dayIdx(m.timestamp); if (i >= 0) days[i].replies += 1; });
  meetings.forEach((m) => { const i = dayIdx(m.createdAt); if (i >= 0) days[i].visits += 1; });

  return {
    range,
    label,
    period: { start, end },
    funnel,
    totals: {
      newLeads: newLeads.length,
      replied: repliedSet.size,
      replyRate: pct(repliedSet.size, outboundLeadIds.length || newLeads.length),
      hot,
      visits: visitSet.size,
      aiVisits: meetings.filter((m) => m.source === 'whatsapp_ai').length,
      booked: booked.length,
      revenue: booked.reduce((a, l) => a + (l.dealValue || 0), 0),
      cpLeads: newLeads.filter((l) => l.channelPartnerId).length,
    },
    bySource,
    byAgent,
    daily: days,
  };
}

/** Plain-text WhatsApp version for the weekly owner report. */
function reportText(companyName, r) {
  const f = Object.fromEntries(r.funnel.map((x) => [x.key, x.value]));
  const lines = [
    `*${companyName} — Weekly report (${r.label})*`,
    '',
    `Nayi leads: *${f.new}*`,
    `Reply aaya: *${f.replied}* (${r.totals.replyRate}%)`,
    `Hot leads: *${f.hot}*`,
    `Site visits book: *${f.visits}* (AI ne ${r.totals.aiVisits})`,
    `Visit hue: *${f.visited}*`,
    `Bookings: *${f.booked}*`,
  ];
  if (r.bySource.length) {
    lines.push('', '*Top sources:*');
    r.bySource.slice(0, 4).forEach((s) => lines.push(`• ${s.source}: ${s.leads} leads, ${s.visits} visits`));
  }
  const agents = r.byAgent.filter((a) => a.userId).slice(0, 5);
  if (agents.length) {
    lines.push('', '*Team:*');
    agents.forEach((a) => lines.push(`• ${a.name}: ${a.assigned} leads, ${a.visits} visits, ${a.booked} bookings`));
  }
  lines.push('', 'Poori report PropAI → Reports mein.');
  return lines.join('\n');
}

module.exports = { buildReport, reportText, rangeFor };
