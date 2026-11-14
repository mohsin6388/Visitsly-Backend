# Email (client ka apna official email)

Har client **Email → Setup** me apna official email connect karta hai (SMTP + App Password).
Campaign usi email se jati hai, aur customer ka reply seedha client ke apne inbox me aata hai.

- Gmail: 2-Step Verification on karke Google Account → Security → App Passwords se 16-digit password banayein.
- Outlook / Zoho / Hostinger etc.: provider ki SMTP host + port (587 ya 465).
- Connect karte waqt login verify hota hai; galat password save nahi hota. Password encrypted store hota hai (`ENCRYPTION_KEY` prod me zaroor set karein).
- **Email → Email details**: sent / failed / pending, date filter, din ke hisaab se count.
- "Sent" = email server ne accept kar li. Inbox delivery / bounce SMTP me track nahi hota.

`BREVO_*` env ab sirf platform ke apne emails (verify email, password reset) ke liye hai.
