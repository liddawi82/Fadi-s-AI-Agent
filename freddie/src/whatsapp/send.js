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

// WhatsApp template SIDs (approved templates)
const WHATSAPP_TEMPLATES = {
  greeting: 'HX8cf904b9610dfb49345a1de30ad7f433',
  calling: 'HXda8b5b44fb245f2e209d0f21c1121990',
  callDone: 'HX488c3feab6586d2d927370c7acb0ff12',
};

/**
 * Send a message using a WhatsApp template. Templates are required for
 * WhatsApp A2P to ensure compliance and delivery.
 */
async function sendWhatsAppTemplate(templateSid, variables = []) {
  try {
    const msg = await client.messages.create({
      from: addressFor(config.twilio.whatsappFrom, 'whatsapp'),
      to: addressFor(config.owner.whatsapp, 'whatsapp'),
      contentSid: templateSid,
      contentVariables: variables,
    });
    log.ok(`Sent via whatsapp (template): "${variables.slice(0, 2).join(', ')}"`);
    return msg;
  } catch (err) {
    log.error(`Could not send WhatsApp template:`, err.message);
    return null;
  }
}

/** Send a plain text message on the given channel (defaults to the last one used). */
export async function sendText(body, channel = currentChannel()) {
  if (!body || !body.trim()) return null;

  // For WhatsApp, use approved templates. For SMS, use free-form text.
  if (channel === 'whatsapp') {
    // Try to determine which template best matches the content
    const lowerBody = body.toLowerCase();
    let templateSid = WHATSAPP_TEMPLATES.greeting;
    let variables = [config.owner.name || 'Fadi'];

    if (lowerBody.includes('call') && lowerBody.includes('now')) {
      templateSid = WHATSAPP_TEMPLATES.calling;
    } else if (
      lowerBody.includes('call') &&
      (lowerBody.includes('completed') || lowerBody.includes('ended') || lowerBody.includes('voicemail'))
    ) {
      templateSid = WHATSAPP_TEMPLATES.callDone;
      variables = [config.owner.name || 'Fadi', body.slice(0, 100)];
    }

    return sendWhatsAppTemplate(templateSid, variables);
  }

  // SMS splits at 160 characters and Twilio bills per segment, so keep replies
  // tighter there than on WhatsApp.
  const limit = channel === 'sms' ? 600 : 1500;

  try {
    const msg = await client.messages.create({
      from: addressFor(config.twilio.whatsappFrom, channel),
      to: addressFor(config.owner.whatsapp, channel),
      body: body.slice(0, limit),
    });
    log.ok(`Sent via ${channel}: "${body.slice(0, 70).replace(/\n/g, ' ')}"`);
    return msg;
  } catch (err) {
    log.error(`Could not send via ${channel}:`, err.message);

    // If SMS fails, there's not much we can do for SMS fallback
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

    // Send the text too, so you can read it when you can't listen.
    await sendText(text, channel);
    log.ok('Sent a voice note.');
    return msg;
  } catch (err) {
    log.warn('Voice reply failed, falling back to text:', err.message);
    return sendText(text, channel);
  }
}

/** Reply in the same shape and on the same channel you used. */
export async function reply(text, { asVoice = false, channel = currentChannel() } = {}) {
  return asVoice ? sendVoice(text, channel) : sendText(text, channel);
}
