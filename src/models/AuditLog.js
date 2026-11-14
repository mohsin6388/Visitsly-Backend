const mongoose = require('mongoose');
const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true }, // e.g. 'lead.create', 'auth.login'
    entityType: { type: String, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    meta: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

auditLogSchema.index({ userId: 1, createdAt: -1 });

// Stamp the current company automatically so each tenant only sees its own log.
auditLogSchema.pre('save', function stampOrg(next) {
  if (!this.orgId) {
    const orgId = require('../context/tenantContext').orgId();
    if (orgId) this.orgId = orgId;
  }
  next();
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
