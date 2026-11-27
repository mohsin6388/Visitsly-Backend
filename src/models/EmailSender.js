const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * A company's official campaign sender (name@theircompany.com), registered in
 * OUR Brevo account through the Senders / Domains API. One sender per company
 * and one company per address (the address is unique across all companies).
 *
 * Campaign mail goes out through the platform Brevo account with
 *   From     = this sender (display name = company name)
 *   Reply-To = this same address
 * so customers reply straight into the company's own inbox.
 */
const emailSenderSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    displayName: { type: String, default: "", trim: true, maxlength: 100 },
    brevoSenderId: { type: Number, default: null },
    status: { type: String, enum: ["awaiting_domain", "pending_verification", "verified", "failed"], default: "pending_verification" },
    domain: { type: String, required: true, trim: true, lowercase: true },
    domainAuthStatus: { type: String, enum: ["not_started", "pending", "authenticated", "failed"], default: "not_started" },
    // Records the client must add at their DNS host (from Brevo; never contains secrets).
    dnsRecords: { type: [new Schema({ key: String, type: String, host: String, value: String, ok: { type: Boolean, default: false } }, { _id: false })], default: [] },
    lastError: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    domainAuthenticatedAt: { type: Date, default: null },
    // Reputation guidelines accepted by the Owner before setup (audit).
    guidelinesAcceptedAt: { type: Date, default: null },
    // Safety: automatic pause (bounce / complaint rate). Cleared by support after review.
    paused: { type: Boolean, default: false },
    pausedReason: { type: String, default: null },
    pausedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EmailSender", emailSenderSchema);
