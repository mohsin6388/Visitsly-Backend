/**
 * Defense in depth for multi-tenancy: any Mongoose query on a model that has
 * an `ownerId` field, running inside a company's tenant context, is
 * automatically limited to that company's workspace — even if the code
 * forgot to add `ownerId` to the filter (e.g. Property.find({ isActive: true })
 * in the AI property matcher). Outside a tenant context (platform admin,
 * scripts) queries are untouched.
 */
const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'replaceOne',
];

module.exports = function tenantScopePlugin(schema) {
  if (!schema.path('ownerId')) return;
  const tenantContext = require('./tenantContext');

  schema.pre(QUERY_HOOKS, function scopeToTenant() {
    const ownerId = tenantContext.ownerId();
    if (!ownerId) return;
    const filter = this.getFilter ? this.getFilter() : this.getQuery();
    if (filter && filter.ownerId === undefined) this.where({ ownerId });
  });

  schema.pre('aggregate', function scopeAggregate() {
    const ownerId = tenantContext.ownerId();
    if (!ownerId) return;
    const pipeline = this.pipeline();
    const first = pipeline[0];
    if (first && first.$match && first.$match.ownerId !== undefined) return;
    const mongoose = require('mongoose');
    pipeline.unshift({ $match: { ownerId: new mongoose.Types.ObjectId(String(ownerId)) } });
  });

  schema.pre('validate', function stampOwner() {
    if (this.ownerId) return;
    const ownerId = tenantContext.ownerId();
    if (ownerId) this.ownerId = ownerId;
  });
};
