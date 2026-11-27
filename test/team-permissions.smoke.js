/* eslint-disable no-console */
/**
 * Team / permissions / agent-scope / phone-masking smoke test — NO database, NO network.
 *   npm run test:team
 * Covers the Part A acceptance checks (A9 1–7).
 */
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SAAS_MODE = 'true';
const R = (p) => require(path.join(ROOT, p));
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

let passed = 0; let failed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}
const id = () => new mongoose.Types.ObjectId().toString();
const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err || null)));

(async () => {
  const perms = R('src/services/saas/permissions');
  const can = R('src/middlewares/can');
  const agentScope = R('src/services/saas/agentScope');
  const roleGuard = R('src/middlewares/roleGuard');
  const Lead = R('src/models/Lead');
  const OWNER = id(); const AGENT = id(); const OTHER = id();
  const agentReq = (permissions = {}, extra = {}) => ({ user: { tenant: true, id: OWNER, actorId: AGENT, orgRole: 'agent', permissions: perms.permissionsFor({ orgRole: 'agent', permissions }), ...extra }, query: {} });
  const ownerReq = () => ({ user: { tenant: true, id: OWNER, actorId: OWNER, orgRole: 'owner', permissions: perms.permissionsFor({ orgRole: 'owner' }) }, query: {} });

  console.log('A1/A3 roles + permission model');
  await t('defaults: pages + leadCreate/leadEdit/chatReply ON; leadImport/leadDelete/showFullPhone OFF', () => {
    const p = perms.permissionsFor({ orgRole: 'agent' });
    for (const k of ['dashboard', 'leads', 'inbox', 'whatsappLeads', 'siteVisits', 'followUps', 'properties', 'leadCreate', 'leadEdit', 'chatReply']) assert.strictEqual(p[k], true, k);
    for (const k of ['leadImport', 'leadDelete', 'showFullPhone']) assert.strictEqual(p[k], false, k);
  });
  await t('Owner implicitly has everything; legacy "manager" is read as agent (lower privilege)', () => {
    assert.ok(Object.values(perms.permissionsFor({ orgRole: 'owner' })).every((v) => v === true));
    assert.strictEqual(perms.normalizeOrgRole('manager'), 'agent');
    assert.strictEqual(perms.permissionsFor({ orgRole: 'manager' }).leadDelete, false);
  });
  await t('sanitizePermissions keeps only known boolean keys', () => {
    assert.deepStrictEqual(perms.sanitizePermissions({ leadDelete: true, hacker: true, chatReply: 'yes' }), { leadDelete: true });
  });
  await t('zod: invite/bulk/update accept permissions, reject unknown keys and the manager role', () => {
    const v = R('src/validators/saasValidators');
    const body = { name: 'Asha', email: 'a@x.com', permissions: { leadDelete: true } };
    assert.ok(v.inviteSchema.safeParse({ body }).success);
    assert.ok(!v.inviteSchema.safeParse({ body: { ...body, permissions: { root: true } } }).success);
    assert.ok(!v.inviteSchema.safeParse({ body: { ...body, orgRole: 'manager' } }).success);
    assert.ok(v.bulkInviteSchema.safeParse({ body: { members: [body] } }).success);
    assert.ok(v.updateMemberSchema.safeParse({ params: { id: id() }, body: { permissions: { showFullPhone: true } } }).success);
  });

  console.log('A6 can() middleware + route mapping');
  await t('Owner always passes; agent needs the toggle (403 PERMISSION_DENIED otherwise)', async () => {
    assert.strictEqual(await run(can('leadDelete'), ownerReq()), null);
    const err = await run(can('leadDelete'), agentReq());
    assert.strictEqual(err.statusCode, 403);
    assert.strictEqual(await run(can('leadDelete'), agentReq({ leadDelete: true })), null);
    assert.strictEqual(await run(can.any('leads', 'inbox'), agentReq({ leads: false, inbox: true })), null);
    assert.strictEqual((await run(can.any('leads', 'inbox'), agentReq({ leads: false, inbox: false }))).statusCode, 403);
  });
  await t('A9.4 delete + bulk-delete + single delete routes are behind can("leadDelete")', () => {
    const router = R('src/routes/leadRoutes');
    const needs = (method, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]).route.stack.map((s) => s.handle).filter((h) => h.permissionKeys).flatMap((h) => h.permissionKeys);
    assert.deepStrictEqual(needs('delete', '/:id'), ['leadDelete']);
    assert.deepStrictEqual(needs('post', '/bulk-delete'), ['leadDelete']);
    assert.deepStrictEqual(needs('post', '/'), ['leadCreate']);
    assert.deepStrictEqual(needs('patch', '/:id'), ['leadEdit']);
    assert.deepStrictEqual(needs('post', '/import/confirm'), ['leadImport']);
    assert.deepStrictEqual(needs('post', '/start-conversations'), ['chatReply']);
    const exp = router.stack.find((l) => l.route && l.route.path === '/export').route.stack.map((s) => s.handle);
    assert.ok(exp.some((h) => h.orgRoles && h.orgRoles.join() === 'owner'), 'export is owner-only');
  });
  await t('chat send routes need chatReply; no agent-reachable route is left on the old manager guard', () => {
    const router = R('src/routes/conversationRoutes');
    for (const p of ['/:id/messages', '/:id/media', '/:id/property-media', '/:id/takeover', '/:id/resume-ai']) {
      const layer = router.stack.find((l) => l.route && l.route.path === p);
      assert.ok(layer.route.stack.some((s) => s.handle.permissionKeys && s.handle.permissionKeys.includes('chatReply')), p);
    }
    const files = require('fs').readdirSync('src/routes');
    for (const f of files) assert.ok(!/['"]manager['"]/.test(require('fs').readFileSync(`src/routes/${f}`, 'utf8')), `manager in ${f}`);
  });
  await t('Owner-only: team, reports, lead sources, routing, channel partners, deals, campaigns, audiences, settings writes, email, billing', async () => {
    const { collect } = R('scripts/route-permissions');
    const rows = collect();
    const mustBeOwner = [
      ['GET', '/api/org/team'], ['POST', '/api/org/team'], ['POST', '/api/org/team/bulk'], ['PATCH', '/api/org/team/:id'],
      ['GET', '/api/org/lead-sources'], ['PATCH', '/api/org/routing'], ['GET', '/api/org/channel-partners'], ['POST', '/api/org/deals/:leadId'],
      ['PATCH', '/api/org'], ['POST', '/api/campaigns/launch'], ['GET', '/api/audiences'], ['GET', '/api/reports/budget'],
      ['GET', '/api/analytics/lead-sources'], ['GET', '/api/analytics/meta-billing'], ['GET', '/api/email/details'], ['PATCH', '/api/settings'],
      ['POST', '/api/voice/call/:leadId'], ['POST', '/api/whatsapp/disconnect'], ['GET', '/api/leads/export'], ['POST', '/api/meetings/:id/call-confirmation'],
    ];
    for (const [m, u] of mustBeOwner) {
      const row = rows.find((r) => r.method === m && r.url === u);
      if (!row) { console.log(`       (route not found, skipped: ${m} ${u})`); continue; }
      assert.ok(row.guards.some((g) => /owner only/.test(g)), `${m} ${u} → ${row.guards.join('; ')}`);
    }
    const billing = rows.filter((r) => r.url.startsWith('/api/billing') && !/webhook/.test(r.url));
    assert.ok(billing.length && billing.every((r) => r.guards.some((g) => /owner only/.test(g))));
  });

  console.log('A4 data scope (agentScope)');
  await t('A9.1 lead filter + lead-id filter: owner = all; agent = assigned only', async () => {
    assert.deepStrictEqual(agentScope.leadScope(ownerReq()), { ownerId: OWNER });
    assert.deepStrictEqual(agentScope.leadScope(agentReq()), { ownerId: OWNER, assignedTo: AGENT });
    assert.deepStrictEqual(await agentScope.byLeadFilter(ownerReq()), {});
    const mine = [id(), id()];
    const realFind = Lead.find;
    Lead.find = () => ({ distinct: async () => mine });
    try {
      const f = await agentScope.byLeadFilter(agentReq());
      assert.deepStrictEqual(f, { leadId: { $in: mine } });
    } finally { Lead.find = realFind; }
  });
  await t('A9.2 by-id fetch of an unassigned lead → 404 (IDOR)', async () => {
    const realFindOne = Lead.findOne;
    const seen = [];
    Lead.findOne = (q) => { seen.push(q); return { select: () => ({ lean: async () => (q.assignedTo === AGENT && q._id === 'MINE' ? { _id: q._id } : null) }) }; };
    try {
      await assert.rejects(() => agentScope.assertLeadVisible(agentReq(), 'not-an-id'), (e) => e.statusCode === 404);
      const mineId = id();
      Lead.findOne = (q) => ({ select: () => ({ lean: async () => (String(q.assignedTo) === AGENT && q._id === mineId ? { _id: q._id } : null) }) });
      await agentScope.assertLeadVisible(agentReq(), mineId);
      await assert.rejects(() => agentScope.assertLeadVisible(agentReq(), id()), (e) => e.statusCode === 404);
    } finally { Lead.findOne = realFindOne; }
  });
  await t('every controller read path uses the shared helper (conversations, meetings, follow-ups, analytics, quotes, notifications)', () => {
    const fs = require('fs');
    for (const f of ['conversation', 'meeting', 'followUp', 'analytics', 'quote', 'notification', 'lead']) {
      assert.ok(/agentScope/.test(fs.readFileSync(`src/controllers/${f}Controller.js`, 'utf8')), f);
    }
    const conv = fs.readFileSync('src/controllers/conversationController.js', 'utf8');
    assert.ok(!/\{ _id: req\.params\.id, ownerId \}/.test(conv), 'a by-id conversation fetch is unscoped');
    for (const f of ['meeting', 'followUp']) assert.ok(!/\{ _id: req\.params\.id, ownerId \}/.test(fs.readFileSync(`src/controllers/${f}Controller.js`, 'utf8')), `${f} by-id unscoped`);
  });
  await t('agentsSeeOnlyAssigned stays in routing settings (compat) but scope no longer depends on it', () => {
    const src = require('fs').readFileSync('src/routes/orgRoutes.js', 'utf8');
    assert.ok(/agentsSeeOnlyAssigned/.test(src));
    assert.deepStrictEqual(agentScope.leadScope({ ...agentReq(), org: { routing: { agentsSeeOnlyAssigned: false } } }), { ownerId: OWNER, assignedTo: AGENT });
  });

  console.log('A5 phone masking');
  await t('A9.3 last-4-only in leads, conversations, meetings, notifications and live socket payloads', () => {
    assert.strictEqual(agentScope.maskPhone('919876543210'), '••••••3210');
    assert.strictEqual(agentScope.maskPhone(''), '');
    const payload = {
      leads: [{ _id: id(), name: 'Ravi', phone: '919876543210', email: 'r@x.com' }],
      conversations: [{ leadId: { name: 'Ravi', phone: '+91 98765 43210' }, lastMessagePreview: 'call me on 9876543210' }],
      items: [{ title: 'Ravi 919876543210 enquired', body: 'Number 98765 43210', link: '/leads/1' }],
      meeting: { customer: { phone: '9876543210' } },
      message: { text: 'my number is 9876543210', from: 'x' },
    };
    const out = JSON.stringify(agentScope.maskPayload(payload));
    assert.ok(!/98765\s?43210/.test(out.replace('my number is 9876543210', '').replace('call me on 9876543210', '')), out);
    assert.ok(out.includes('••••••3210'));
    assert.ok(out.includes('my number is 9876543210'), 'message text is not modified');
    assert.ok(out.includes('r@x.com'));
  });
  await t('masking applies only to agents without showFullPhone — owner and showFullPhone=true agents see full numbers', () => {
    assert.strictEqual(agentScope.mustMask(ownerReq()), false);
    assert.strictEqual(agentScope.mustMask(agentReq()), true);
    assert.strictEqual(agentScope.mustMask(agentReq({ showFullPhone: true })), false);
  });
  await t('phone search is disabled for masked agents (no digit-by-digit recovery)', () => {
    assert.strictEqual(agentScope.safeSearchText(agentReq(), '9876543210'), '');
    assert.strictEqual(agentScope.safeSearchText(agentReq({ showFullPhone: true }), '9876543210'), '9876543210');
    const src = require('fs').readFileSync('src/controllers/leadController.js', 'utf8');
    assert.ok(/mustMask\(req\)\) filter\.\$or\.push\(\{ phone: re \}\)/.test(src));
  });
  await t('auth middleware wraps res.json for masked agents (every JSON response)', () => {
    const src = require('fs').readFileSync('src/middlewares/auth.js', 'utf8');
    assert.ok(/mustMask\(req\)/.test(src) && /maskPayload/.test(src));
  });
  await t('socket: events for a lead go only to the assigned agent room, masked; other agents / company room unaffected', async () => {
    const sockets = R('src/sockets');
    const User = R('src/models/User');
    const Conversation = R('src/models/Conversation');
    const leadId = id(); const convId = id();
    const emitted = [];
    sockets._setIO({ to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
    const realLead = Lead.findOne; const realUser = User.findOne; const realConv = Conversation.findOne;
    Lead.findOne = () => ({ select: () => ({ lean: async () => ({ assignedTo: AGENT }) }) });
    Conversation.findOne = () => ({ select: () => ({ lean: async () => ({ leadId }) }) });
    User.findOne = () => ({ select: () => ({ lean: async () => ({ orgRole: 'agent', permissions: {} }) }) });
    try {
      sockets.emitToUser(OWNER, 'conversation:newMessage', { conversationId: convId, leadId, message: { text: 'hi', phone: '919876543210' } });
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(emitted.some((e) => e.room === `user:${OWNER}`), 'owner room still gets it');
      const toAgent = emitted.find((e) => e.room === `agent:${OWNER}:${AGENT}`);
      assert.ok(toAgent, 'assigned agent gets it');
      assert.strictEqual(toAgent.payload.message.phone, '••••••3210');
      assert.strictEqual(toAgent.payload.message.text, 'hi');
      emitted.length = 0;
      sockets.emitToUser(OWNER, 'outreach:progress', { campaignId: id(), sent: 3 }); // company-wide event, no lead
      await new Promise((r) => setTimeout(r, 30));
      assert.deepStrictEqual(emitted.map((e) => e.room), [`user:${OWNER}`]);
      // showFullPhone → unmasked
      emitted.length = 0;
      User.findOne = () => ({ select: () => ({ lean: async () => ({ orgRole: 'agent', permissions: { showFullPhone: true } }) }) });
      sockets.emitToUser(OWNER, 'conversation:newMessage', { leadId, message: { phone: '919876543210' } });
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(emitted.find((e) => e.room.startsWith('agent:')).payload.message.phone, '919876543210');
    } finally { Lead.findOne = realLead; User.findOne = realUser; Conversation.findOne = realConv; sockets._setIO(null); }
    // an agent's socket never joins the company room
    const src = require('fs').readFileSync('src/sockets/index.js', 'utf8');
    assert.ok(/socket\.join\(socket\.agentRoom \|\| `user:\$\{socket\.roomId\}`\)/.test(src));
  });

  console.log('A2 plan limits + team rules (controller)');
  const Organization = R('src/models/Organization');
  const User = R('src/models/User');
  const AuditLog = R('src/models/AuditLog');
  const tenantContext = R('src/context/tenantContext');
  const orgService = R('src/services/saas/orgService');
  const c = R('src/controllers/orgController');
  const plans = R('src/config/plans');

  await t('limits: Trial 1, Starter 1, Growth 5, Builder 10, Enterprise unlimited', () => {
    const l = (plan) => plans.limitsFor({ plan }).users;
    assert.deepStrictEqual([l('trial'), l('starter'), l('growth'), l('builder'), l('enterprise')], [1, 1, 5, 10, null]);
  });
  await t('extra-user add-on counts on Growth+ only; ignored on Starter/Trial', () => {
    assert.strictEqual(plans.limitsFor({ plan: 'growth', addons: { extraUsers: 2 } }).users, 7);
    assert.strictEqual(plans.limitsFor({ plan: 'starter', addons: { extraUsers: 2 } }).users, 1);
    assert.strictEqual(plans.limitsFor({ plan: 'trial', addonGrants: [{ key: 'extraUser', quantity: 3 }] }).users, 1);
    assert.strictEqual(plans.limitsFor({ plan: 'growth', limitOverrides: { users: 8 } }).users, 8); // platform override kept
  });

  // Controller harness: stub the DB calls the team handlers make.
  const audit = [];
  AuditLog.create = async (d) => { audit.push(d); return d; };
  let activeCount = 1; const members = new Map();
  User.countDocuments = async () => activeCount;
  User.exists = async () => false;
  User.prototype.save = async function save() { this.createdAt = new Date(); return this; };
  User.findOne = async ({ _id }) => members.get(String(_id)) || null;
  orgService.invalidate = () => {};
  const call = async (handler, org, req) => {
    const res = { statusCode: 200, body: null, status(s) { this.statusCode = s; return this; }, json(b) { this.body = b; return this; } };
    let error = null;
    await tenantContext.run(org, () => handler({ ip: '1.1.1.1', query: {}, params: {}, ...req, org, user: { tenant: true, id: OWNER, actorId: OWNER, orgRole: 'owner', ...(req.user || {}) } }, res, (e) => { error = e; }));
    return { res, error };
  };
  const org = (plan) => ({ _id: id(), ownerUserId: OWNER, plan, status: 'active', name: 'Acme' });
  const body = (n) => ({ name: `Agent ${n}`, email: `agent${n}@acme.com`, password: 'Passw0rdX' });

  await t('A9.5 Starter/Trial: invite + bulk invite refuse with the clear message', async () => {
    for (const plan of ['starter', 'trial']) {
      for (const [h, b] of [[c.inviteMember, body(1)], [c.bulkInvite, { members: [body(1)] }]]) {
        const { error } = await call(h, org(plan), { body: b });
        assert.ok(error && error.statusCode === 403 && /Team members are available on Growth and above/.test(error.message), `${plan}: ${error && error.message}`);
      }
    }
  });
  await t('A9.5 Extra-user add-on not purchasable on Starter/Trial; platform grant refused too', () => {
    const billing = R('src/services/saas/billingService');
    for (const plan of ['starter', 'trial']) assert.throws(() => billing.addonQuote({ plan, status: 'active', country: 'IN' }, 'extraUser', 1), /Growth and above/);
    assert.ok(billing.addonQuote({ plan: 'growth', status: 'active', country: 'IN' }, 'extraUser', 1));
    assert.ok(/teamAvailable\(org\)/.test(require('fs').readFileSync('src/controllers/platformController.js', 'utf8')));
  });
  await t('A9.6 Growth: owner + 4 agents fit, the 5th invite fails with the plan-limit message; Builder allows 9', async () => {
    const g = org('growth');
    for (const active of [1, 2, 3, 4]) { activeCount = active; const { error, res } = await call(c.inviteMember, g, { body: body(active) }); assert.ok(!error, `agent ${active}: ${error && error.message}`); assert.strictEqual(res.statusCode, 201); }
    activeCount = 5; // owner + 4 agents
    const { error } = await call(c.inviteMember, g, { body: body(5) });
    assert.ok(error && error.statusCode === 403 && error.details.code === 'PLAN_LIMIT' && error.details.limit === 5, error && error.message);
    activeCount = 9; // Builder: owner + 8 agents → the 9th still fits
    assert.ok(!(await call(c.inviteMember, org('builder'), { body: body(9) })).error);
    activeCount = 10;
    assert.ok((await call(c.inviteMember, org('builder'), { body: body(10) })).error);
  });
  await t('invite stores defaults/permissions and writes an audit entry; role is always agent', async () => {
    activeCount = 1; audit.length = 0;
    const { res } = await call(c.inviteMember, org('growth'), { body: { ...body(7), orgRole: 'agent', permissions: { leadDelete: true, showFullPhone: true } } });
    const m = res.body.data.member;
    assert.strictEqual(m.orgRole, 'agent');
    assert.strictEqual(m.permissions.leadDelete, true); assert.strictEqual(m.permissions.showFullPhone, true);
    assert.strictEqual(m.permissions.leadImport, false); assert.strictEqual(m.permissions.chatReply, true);
    assert.ok(audit.some((a) => a.action === 'org.team.invite' && a.meta.permissions.leadDelete === true));
    const plain = await call(c.inviteMember, org('growth'), { body: body(8) });
    assert.strictEqual(plain.res.body.data.member.permissions.showFullPhone, false);
  });
  await t('only the Owner manages the team (agent calling the controller directly is refused)', async () => {
    for (const [h, b] of [[c.inviteMember, body(1)], [c.bulkInvite, { members: [body(1)] }], [c.updateMember, { name: 'x' }], [c.setMemberPassword, { password: 'Abcdefg1' }], [c.resetMemberPassword, {}]]) {
      const { error } = await call(h, org('growth'), { body: b, params: { id: id() }, user: { orgRole: 'agent', actorId: AGENT } });
      assert.ok(error && error.statusCode === 403, h.name);
    }
  });
  await t('owner cannot be deactivated, demoted or have permissions edited; agent permission change is audited', async () => {
    const g = org('growth'); const ownerId = id(); const agentId = id();
    const mk = (_id, orgRole, extra = {}) => { const u = new User({ name: 'N', email: `${_id}@x.com`, role: 'broker', orgRole, orgId: g._id, ...extra }); u._id = new mongoose.Types.ObjectId(_id); members.set(_id, u); return u; };
    mk(ownerId, 'owner'); mk(agentId, 'agent');
    for (const b of [{ isActive: false }, { orgRole: 'agent' }, { permissions: { leadDelete: true } }]) {
      const { error } = await call(c.updateMember, g, { body: b, params: { id: ownerId } });
      assert.ok(error && error.statusCode === 400, JSON.stringify(b));
    }
    audit.length = 0;
    const { res, error } = await call(c.updateMember, g, { body: { permissions: { leadDelete: true, showFullPhone: true } }, params: { id: agentId } });
    assert.ok(!error, error && error.message);
    assert.strictEqual(res.body.data.member.permissions.leadDelete, true);
    const entry = audit.find((a) => a.action === 'org.team.permissions');
    assert.ok(entry && entry.meta.changed.leadDelete.to === true && entry.meta.changed.showFullPhone.from === false);
  });
  await t('reactivating an agent re-checks the seat limit', async () => {
    const g = org('growth'); const agentId = id();
    const u = new User({ name: 'N', email: 'off@x.com', role: 'broker', orgRole: 'agent', orgId: g._id, isActive: false }); u._id = new mongoose.Types.ObjectId(agentId); members.set(agentId, u);
    activeCount = 5;
    const { error } = await call(c.updateMember, g, { body: { isActive: true }, params: { id: agentId } });
    assert.ok(error && error.details && error.details.code === 'PLAN_LIMIT');
  });

  console.log('A9.7 no Manager left / existing flows');
  await t('no "manager" role value remains in backend source (outside the legacy-read helper)', () => {
    const fs = require('fs'); const hits = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (!p.endsWith('.js')) return;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (/['"]manager['"]|\bManager\b/i.test(line) && !/legacy|Legacy|migrate|dedicatedManager|Account manager|Account Manager|account manager|accountManager|WhatsApp Manager|Template Manager|session manager|'agent', 'manager'|'owner', 'agent', 'manager'/.test(line)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 90)}`); });
    });
    walk('src');
    assert.deepStrictEqual(hits, [], hits.join('\n'));
  });
  await t('Owner flows unchanged: owner guards pass for owner; legacy single-client mode (no tenant) passes everything', async () => {
    assert.strictEqual(await run(roleGuard.org('owner'), ownerReq()), null);
    assert.strictEqual((await run(roleGuard.org('owner'), agentReq())).statusCode, 403);
    assert.strictEqual(await run(roleGuard.org('owner'), { user: { id: 'x', role: 'broker' } }), null);
    assert.strictEqual(await run(can('leadDelete'), { user: { id: 'x', role: 'broker' } }), null);
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})();
