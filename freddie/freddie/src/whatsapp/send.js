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

/** Send a plain text message on the given channel (defaults to the last one used). */
export async function sendText(body, channel = currentChannel()) {
  if (!body || !body.trim()) return null;

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

    // If WhatsApp fails (expired sandbox session is the usual cause) try SMS,
    // so a call report isn't silently lost.
    if (channel === 'whatsapp') {
      log.warn('Falling back to SMS.');
      return sendText(body, 'sms');
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
