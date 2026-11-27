const mongoose = require('mongoose');
const env = require('./env');

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(env.mongoUri, {
      autoIndex: env.nodeEnv !== 'production', // build general indexes automatically only outside prod
    });
    // Security/abuse hygiene index must also exist in production, where normal
    // Mongoose auto-indexing is disabled. It only expires unverified signup rows.
    await mongoose.connection.collection('users').createIndex(
      { emailVerificationExpires: 1 },
      {
        expireAfterSeconds: 0,
        partialFilterExpression: { emailVerified: false },
        name: 'unverified_email_signup_ttl',
      }
    ).catch((indexErr) => {
      console.warn('[db] Could not ensure unverified-email TTL index:', indexErr.message);
    });
    // The Meta OAuth code is single-use; the encrypted handoff must expire
    // even when production autoIndex is disabled.
    await mongoose.connection.collection('whatsappconnectionattempts').createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 }
    ).catch((indexErr) => {
      console.warn('[db] Could not ensure WhatsApp connection-attempt TTL index:', indexErr.message);
    });
    isConnected = true;
    console.log(`[db] MongoDB connected -> ${mongoose.connection.host}/${mongoose.connection.name}`);
  } catch (err) {
    console.error('[db] MongoDB connection failed:', err.message);
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected');
    isConnected = false;
  });

  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB error:', err.message);
  });

  return mongoose.connection;
}

module.exports = connectDB;
