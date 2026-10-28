const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');

const env = require('./config/env');
const routes = require('./routes');
const { apiLimiter } = require('./middlewares/rateLimit');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

const app = express();

app.set('trust proxy', 1); // needed for correct IPs / secure cookies behind a proxy (Render, Nginx, etc.)

app.use(helmet());

// app.use(
//   cors({
//     origin: "*",
//   })
// );

// Public lead-capture endpoints (website forms on customers' own sites) accept any origin.
app.use('/api/inbound', cors({ origin: true, credentials: true })); // reflects any origin; these endpoints use no cookies
// Everything else: customer app, admin panel, extra origins, white-label domains.
app.use(cors(require('./services/saas/corsOrigins').corsOptions()));


// Keeps the raw request body around (req.rawBody) alongside the parsed
// req.body — needed to verify Meta's X-Hub-Signature-256 header on inbound
// WhatsApp webhook POSTs (see middlewares/verifyMetaSignature.js). Harmless
// for every other route; the buffer is just discarded if unused.
app.use(
  express.json({
    limit: '5mb', // 5000-lead bulk upload (campaign launch) ke liye
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(mongoSanitize()); // strips $/. operators from user input to block NoSQL injection
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(apiLimiter);

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
