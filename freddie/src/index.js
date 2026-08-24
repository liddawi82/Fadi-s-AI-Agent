// Freddie's front door.
//
// Three things call into this server:
//   Twilio  -> POST /whatsapp     when you send a message
//   Vapi    -> POST /vapi/tools   when Freddie needs something mid-call
//   Vapi    -> POST /vapi/events  when a call ends
//
// Plus GET /health, which is how you check he's alive.

import express from 'express';
import path from 'node:path';
import twilio from 'twilio';
import { config } from './config.js';
import { handleInbound } from './whatsapp/inbound.js';
import { handleToolCall, handleVapiEvent, verifyVapi } from './calls/webhook.js';
import { log } from './util/log.js';

const app = express();
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));

// Voice notes Freddie generates are served from here so Twilio can fetch them.
app.use('/audio', express.static(path.join(process.cwd(), 'public', 'audio'), { maxAge: '1h' }));

// ── health ──────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.type('text').send('Freddie is awake.'));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    publicUrl: config.publicUrl || '(not set — Freddie cannot place calls or send voice notes)',
    whatsappFrom: config.twilio.whatsappFrom,
    canPlaceCalls: Boolean(config.vapi.phoneNumberId && config.publicUrl),
    confirmBeforeCalling: config.behaviour.requireConfirmation,
    voiceReplies: config.behaviour.voiceReplies,
  });
});

// ── WhatsApp ────────────────────────────────────────────────────────────────

/**
 * Confirms the request really came from Twilio. Without this, anyone who finds
 * Freddie's URL could impersonate you by faking the From field.
 */
function twilioIsGenuine(req) {
  const signature = req.get('X-Twilio-Signature');
  if (!signature) return false;
  const url = `${config.publicUrl || `https://${req.get('host')}`}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
}

function receiveMessage(req, res) {
  // Answer Twilio immediately with an empty 200. Thinking and calling take far
  // longer than the 15 seconds Twilio allows, so the work happens afterwards.
  //
  // Deliberately NOT TwiML: trial accounts don't accept a TwiML response body,
  // and Freddie sends his replies through the REST API anyway.
  res.status(200).type('text/plain').send('');

  if (!twilioIsGenuine(req)) {
    log.warn(`Rejected a ${req.originalUrl} request with a bad or missing Twilio signature.`);
    return;
  }

  handleInbound(req.body).catch((err) =>
    log.error('Inbound handling failed:', err.stack || err.message)
  );
}

// Both paths do the same thing. Freddie works over WhatsApp and SMS, and
// answers on whichever one you messaged him from — the two names just make the
// Twilio console easier to reason about.
app.post('/whatsapp', receiveMessage);
app.post('/sms', receiveMessage);

// ── Vapi ────────────────────────────────────────────────────────────────────

app.post('/vapi/tools', async (req, res) => {
  if (!verifyVapi(req)) {
    log.warn('Rejected a /vapi/tools request with a bad secret.');
    return res.status(401).json({ error: 'bad secret' });
  }
  try {
    // This one must stay open: Freddie is holding the phone line while it runs.
    const result = await handleToolCall(req.body?.message);
    res.json(result);
  } catch (err) {
    log.error('Tool call failed:', err.stack || err.message);
    res.json({ results: [{ toolCallId: 'unknown', result: 'That failed. Carry on without it.' }] });
  }
});

app.post('/vapi/events', (req, res) => {
  if (!verifyVapi(req)) {
    log.warn('Rejected a /vapi/events request with a bad secret.');
    return res.status(401).json({ error: 'bad secret' });
  }
  res.json({ received: true });
  handleVapiEvent(req.body?.message).catch((err) =>
    log.error('Event handling failed:', err.stack || err.message)
  );
});

// ── start ───────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  log.ok(`Freddie is listening on port ${config.port}`);
  log.info(`  WhatsApp number : ${config.twilio.whatsappFrom}`);
  log.info(`  Owner           : ${config.owner.whatsapp}`);
  log.info(`  Public URL      : ${config.publicUrl || 'NOT SET'}`);

  if (!config.publicUrl) {
    log.warn('PUBLIC_URL is empty. Freddie can receive messages but cannot place calls');
    log.warn('or send voice notes. Paste your Railway URL into PUBLIC_URL and redeploy.');
  }
  if (!config.vapi.phoneNumberId) {
    log.warn('VAPI_PHONE_NUMBER_ID is empty, so Freddie has no line to call out on.');
  }
  if (!config.vapi.webhookSecret) {
    log.warn('VAPI_WEBHOOK_SECRET is empty. Anyone who guesses this URL could fake a call event.');
  }
});

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err?.stack || err));
