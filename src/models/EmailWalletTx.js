const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Ledger of the per-email wallet. `key` makes every movement idempotent
 * (e.g. "debit:job:<jobId>", "recharge:inv:<invoiceId>"). Amounts are integer
 * milli-rupees (1 INR = 1000); never floats.
 */
const emailWalletTxSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    key: { type: String, required: true, unique: true },
    type: { type: String, enum: ["recharge", "debit", "admin_credit", "admin_debit"], required: true },
    amountMilli: { type: Number, required: true }, // always positive; `type` gives the direction
    emails: { type: Number, default: 0 },
    // Our own cost / margin split, for the admin panel only (never sent to clients).
    costMilli: { type: Number, default: 0 },
    marginMilli: { type: Number, default: 0 },
    refundedAt: { type: Date, default: null },
    jobId: { type: Schema.Types.ObjectId, default: undefined },
    invoiceId: { type: Schema.Types.ObjectId, default: undefined },
    actorId: { type: Schema.Types.ObjectId, default: undefined },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);
emailWalletTxSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailWalletTx", emailWalletTxSchema);
