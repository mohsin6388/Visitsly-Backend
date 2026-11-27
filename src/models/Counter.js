const mongoose = require('mongoose');

/** Tiny atomic sequence store (e.g. invoice numbers per financial year). _id = the sequence name. */
const counterSchema = new mongoose.Schema(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { versionKey: false },
);

module.exports = mongoose.model('Counter', counterSchema);
