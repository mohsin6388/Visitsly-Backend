const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Client ka apna official email (SMTP). Har company ka sirf ek account.
 * Campaign emails isi account se jaati hain, isliye "From" client ka apna
 * email hota hai aur customer ka reply seedha client ke inbox me aata hai.
 * Password AES-256-GCM se encrypted store hota hai, API se kabhi wapas nahi aata.
 */
const emailAccountSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    fromEmail: { type: String, required: true, trim: true, lowercase: true },
    fromName: { type: String, default: "", trim: true, maxlength: 100 },
    host: { type: String, required: true, trim: true, lowercase: true },
    port: { type: Number, required: true, default: 587 },
    secure: { type: Boolean, default: false }, // true = SSL (465), false = STARTTLS (587)
    username: { type: String, required: true, trim: true },
    passwordEncrypted: { type: String, required: true, select: false },
    status: { type: String, enum: ["connected", "error"], default: "connected" },
    lastError: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EmailAccount", emailAccountSchema);
