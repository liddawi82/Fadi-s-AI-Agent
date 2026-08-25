// Sending messages back to you — over WhatsApp or SMS, whichever you used last.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import twilio from 'twilio';
import OpenAI from 'openai';
import { config } from '../config.js';
import { currentChannel, addressFor } from '../channel.js';
import { log } from '../util/log.js';

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const openai = new OpenAI({ apiKey: config.openai.apiKey });

const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');

// Approved WhatsApp templates, used ONLY when a free-form reply is refused
// because the 24-hour customer-service window has closed.
const WHATSAPP_TEMPLATES = {
  greeting: 'HX8cf904b9610dfb49345a1de30ad7f433',  // "Hi {{1}}, I'm here to help. What do you need?"
  calling: 'HXda8b5b44fb245f2e209d0f21c1121990',   // "I'm calling {{1}} now. Please pick up"
};

// Twilio codes that mean "this message was fine, but the free-form window is shut".
// Anything else is a real error and should NOT be retried as a template.
const WINDOW_CLOSED_CODES = new Set([63016, 63051, 63032]);

/**
 * A message that Twilio ACCEPTS can still never arrive — it sits at "queued"
 * or flips to "undelivered" minutes later with a code that only shows up in
 * Twilio's own logs. That invisible failure is exactly what made Freddie look
 * broken for hours, so every outbound message now reports its real fate here.
 */
function reportDeliveryLater(sid, label) {
  if (!sid) return;
  setTimeout(() => {
    client.messages(sid).fetch()
      .then((m) => {
        const detail = `status=${m.status}` +
          (m.errorCode ? ` errorCode=${m.errorCode} (${m.errorMessage || 'no message'})` : '');
        if (['delivered', 'read', 'sent'].includes(m.status)) log.ok(`${label} → ${detail}`);
        else log.error(`${label} → ${detail}`);
      })
      .catch((err) => log.warn(`Could not read back ${label}:`, err.message));
  }, 8000).unref?.();
}

/** Log a Twilio failure with the code, which is the only part that identifies the cause. */
function logTwilioError(what, err) {
  const code = err?.code ? ` [code ${err.code}]` : '';
  const more = err?.moreInfo ? ` ${err.moreInfo}` : '';
  log.error(`${what}:${code} ${err?.message || err}${more}`);
}

/**
 * Fall back to an approved template when the free-form window is closed.
 *
 * ContentVariables must be a JSON *string* of key-value pairs keyed by the
 * template's placeholder numbers — {"1":"Fadi"}. Passing an array is what
 * produced "The Content Variables parameter is invalid" (Twilio error 92007).
 */
async function sendWhatsAppTemplate(templateSid, variables = []) {
  const contentVariables = {};
  variables.forEach((value, i) => { contentVariables[String(i + 1)] = String(value); });

  try {
    const msg = await client.messages.create({
      from: addressFor(config.twilio.whatsappFrom, 'whatsapp'),
      to: addressFor(config.owner.whatsapp, 'whatsapp'),
      contentSid: templateSid,
      contentVariables: JSON.stringify(contentVariables),
    });
    log.ok(`Sent WhatsApp template ${templateSid.slice(0, 10)}… ${JSON.stringify(contentVariables)}`);
    reportDeliveryLater(msg.sid, 'template message');
    return msg;
  } catch (err) {
    logTwilioError('Could not send WhatsApp template', err);
    return null;
  }
}

/** Send a plain text message on the given channel (defaults to the last one used). */
export async function sendText(body, channel = currentChannel()) {
  if (!body || !body.trim()) return null;

  // SMS splits at 160 characters and Twilio bills per segment, so keep replies
  // tighter there than on WhatsApp.
  const limit = channel === 'sms' ? 600 : 1500;

  // Replying inside the 24-hour customer-service window — which your own
  // message just opened — does NOT require a template. Free-form is the
  // normal path; the template is only the backstop.
  try {
    const msg = await client.messages.create({
      from: addressFor(config.twilio.whatsappFrom, channel),
      to: addressFor(config.owner.whatsapp, channel),
      body: body.slice(0, limit),
    });
    log.ok(`Sent via ${channel}: "${body.slice(0, 70).replace(/\n/g, ' ')}"`);
    reportDeliveryLater(msg.sid, `${channel} message`);
    return msg;
  } catch (err) {
    logTwilioError(`Could not send via ${channel}`, err);

    if (channel === 'whatsapp' && WINDOW_CLOSED_CODES.has(err?.code)) {
      log.warn('Free-form window is closed — falling back to an approved template.');
      const lower = body.toLowerCase();
      const useCalling = lower.includes('calling') || (lower.includes('call') && lower.includes('now'));
      return sendWhatsAppTemplate(
        useCalling ? WHATSAPP_TEMPLATES.calling : WHATSAPP_TEMPLATES.greeting,
        [config.owner.name || 'Fadi'],
      );
    }

    return null;
  }
}

/**
 * Turn text into speech and send it as a voice note.
 *
 * WhatsApp only — SMS can carry media as MMS, but not reliably on a trial
 * account, so Freddie sends text there instead.
 */
export async function sendVoice(text, channel = currentChannel()) {
  if (!config.behaviour.voiceReplies) return sendText(text, channel);
  if (channel !== 'whatsapp') return sendText(text, channel);
  if (!config.publicUrl) {
    log.warn('No PUBLIC_URL set, so voice replies are not possible. Sending text.');
    return sendText(text, channel);
  }

  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });

    const speech = await openai.audio.speech.create({
      model: config.openai.ttsModel,
      voice: config.openai.ttsVoice,
      input: text.slice(0, 3000),
      response_format: 'opus',
    });

    const id = crypto.randomBytes(8).toString('hex');
    const file = path.join(AUDIO_DIR, `${id}.ogg`);
    fs.writeFileSync(file, Buffer.from(await speech.arrayBuffer()));

    // Clean up after an hour — Twilio only needs it for a few seconds.
    setTimeout(() => fs.rm(file, { force: true }, () => {}), 60 * 60 * 1000).unref?.();

    const msg = await client.messages.create({
      from: addressFor(config.twilio.whatsappFrom, 'whatsapp'),
      to: addressFor(config.owner.whatsapp, 'whatsapp'),
      mediaUrl: [`${config.publicUrl}/audio/${id}.ogg`],
    });
    reportDeliveryLater(msg.sid, 'voice note');

    // Send the text too, so you can read it when you can't listen.
    await sendText(text, channel);
    log.ok('Sent a voice note.');
    return msg;
  } catch (err) {
    logTwilioError('Voice reply failed, falling back to text', err);
    return sendText(text, channel);
  }
}

/** Reply in the same shape and on the same channel you used. */
export async function reply(text, { asVoice = false, channel = currentChannel() } = {}) {
  return asVoice ? sendVoice(text, channel) : sendText(text, channel);
}
