const { POLICY_VERSION, RULES } = require("../services/compliance/messagingPolicy");

/**
 * Bulk Messaging & Acceptable Use Policy — the rules every customer accepts
 * before launching a WhatsApp or email campaign. Served as data so the app,
 * the website and support all show the same text.
 */
function policy() {
  const quiet = `${RULES.quietEnd}–${RULES.quietStart}`;
  return {
    version: POLICY_VERSION,
    updated: "2026-11-11",
    title: "Bulk Messaging & Acceptable Use Policy",
    intro:
      "These rules apply to every WhatsApp and email campaign sent through Visitsly. They protect your WhatsApp number and our email domain from being blocked, and help you follow Meta's WhatsApp Business Messaging Policy, Gmail/Yahoo bulk-sender rules, and the marketing and data-protection laws of India and the UAE.",
    sections: [
      {
        heading: "1. Only message people who agreed",
        points: [
          "Send campaigns only to people who gave you their number or email and agreed to hear from you — for example they enquired about a property, filled your form, or are your existing customers.",
          "Do not upload bought, rented, scraped or shared contact lists. Do not message numbers taken from portals or groups without the person's permission.",
          "Keep a record of where each contact came from and when they agreed. You may be asked for it by Meta, a regulator or Visitsly.",
          "India: personal data must be used only for the purpose the person agreed to (Digital Personal Data Protection Act, 2023). UAE: follow the Personal Data Protection Law (Federal Decree-Law No. 45 of 2021) and TDRA rules for marketing messages.",
        ],
      },
      {
        heading: "2. Respect opt-outs immediately",
        points: [
          "WhatsApp: a contact who replies STOP, UNSUBSCRIBE, BAND KARO or إلغاء is opted out automatically and never gets campaign messages again unless they reply START.",
          "Email: every campaign email carries an unsubscribe link and a one-click unsubscribe header. Unsubscribed, bounced and spam-complaint addresses are blocked automatically.",
          "Never re-add an opted-out contact under a new name, number or list.",
        ],
      },
      {
        heading: "3. WhatsApp rules",
        points: [
          "Business-initiated messages must use a template approved by Meta. Free-text replies are only allowed within 24 hours of the customer's last message.",
          "Follow Meta's WhatsApp Business Messaging Policy and Commerce Policy. Meta can limit or block your number if people block or report you.",
          "If Meta marks your number's quality RED or FLAGGED, Visitsly pauses your WhatsApp campaigns automatically until quality recovers.",
          "Meta's conversation charges are separate from your plan and are paid through your Visitsly wallet.",
        ],
      },
      {
        heading: "4. Email rules",
        points: [
          "Use a real sender name and a subject line that matches the content. No fake 'Re:' or 'Fwd:' subjects.",
          "Add your company's postal address in Settings — it is printed in every campaign email.",
          "New senders warm up gradually: about 100 emails a day for the first 3 days, rising to the full daily limit after 14 days.",
        ],
      },
      {
        heading: "5. Timing and frequency",
        points: [
          `Campaign messages go out only between ${RULES.quietEnd} and ${RULES.quietStart} in your local time (India: IST, UAE: GST). Messages due during quiet hours (${quiet}) wait for the morning.`,
          `Each contact gets at most 1 campaign message per channel every ${RULES.minGapHours} hours, and at most ${RULES.maxPerWeek} per week.`,
          `Daily limits per company: ${RULES.whatsappDailyLimit.toLocaleString("en-IN")} WhatsApp and ${RULES.emailDailyLimit.toLocaleString("en-IN")} email campaign messages in any 24 hours, unless your account has a different agreed limit.`,
        ],
      },
      {
        heading: "6. Honest property advertising",
        points: [
          "Prices, offers, possession dates and amenities in your messages must be true and current.",
          "India: show the project's RERA registration number where the law requires it. UAE/Dubai: show the DLD/RERA advertising permit (Trakheesi) number where required.",
          "Do not promise guaranteed returns, rental yields or appreciation unless you can prove them in writing.",
        ],
      },
      {
        heading: "7. Not allowed",
        points: [
          "Spam, harassment, threats, or repeated messages to people who did not reply.",
          "Misleading, fraudulent, phishing or impersonating content.",
          "Adult, gambling, illegal or hateful content, or anything Meta's policies prohibit.",
          "Sharing your contacts' data with anyone who is not authorised to use it.",
        ],
      },
      {
        heading: "8. Automatic safety pauses",
        points: [
          `A campaign pauses itself when, after ${RULES.minSample} messages, more than ${Math.round(RULES.maxFailRate * 100)}% of WhatsApp messages fail, more than ${Math.round(RULES.maxOptOutRate * 100)}% of people reply STOP, more than ${Math.round(RULES.maxBounceRate * 100)}% of emails bounce, or more than ${(RULES.maxComplaintRate * 100).toFixed(1)}% mark the email as spam.`,
          "You will get a notification with the reason. Fix the list or the message before resuming.",
        ],
      },
      {
        heading: "9. Your responsibility",
        points: [
          "You are responsible for the contacts you upload and the messages you send. You confirm you have the right to contact them.",
          "Visitsly may pause campaigns or suspend an account that breaks this policy, Meta's policies or the law, to protect other customers and the platform.",
          "We keep records of opt-outs, consent confirmations and campaign launches so we can show they were respected.",
        ],
      },
    ],
    acceptanceText:
      "I confirm these contacts agreed to receive messages from my business, and I accept the Bulk Messaging & Acceptable Use Policy.",
  };
}

const getPolicy = (req, res) => res.json({ success: true, data: policy() });

module.exports = { getPolicy, policy };
