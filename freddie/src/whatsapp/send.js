// Sending messages back to you on WhatsApp — text, and optionally a voice note.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import twilio from 'twilio';
import OpenAI from 'openai';
import { config } from '../config.js';
import { log } from '../util/log.js';

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const openai = new OpenAI({ apiKey: config.openai.apiKey });

const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');

/** Send a plain text WhatsApp message. */
export async function sendText(body) {
  if (!body || !body.trim()) return null;
  try {
    const msg = await client.messages.create({
      from: `whatsapp:${config.twilio.whatsappFrom}`,
      to: `whatsapp:${config.owner.whatsapp}`,
      body: body.slice(0, 1500),
    });
    log.ok(`Sent: "${body.slice(0, 70).replace(/\n/g, ' ')}"`);
    return msg;
  } catch (err) {
    log.error('Could not send WhatsApp message:', err.message);
    return null;
  }
}

/**
 * Turn text into speech and send it as a WhatsApp voice note.
 *
 * Twilio needs a public URL for the audio, so Freddie writes the file into his
 * own public folder and serves it himself. Files are cleaned up after an hour.
 */
export async function sendVoice(text) {
  if (!config.behaviour.voiceReplies) return sendText(text);
  if (!config.publicUrl) {
    log.warn('No PUBLIC_URL set, so voice replies are not possible. Sending text.');
    return sendText(text);
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
      from: `whatsapp:${config.twilio.whatsappFrom}`,
      to: `whatsapp:${config.owner.whatsapp}`,
      mediaUrl: [`${config.publicUrl}/audio/${id}.ogg`],
    });

    // Send the text too, so you can read it when you can't listen.
    await sendText(text);
    log.ok('Sent a voice note.');
    return msg;
  } catch (err) {
    log.warn('Voice reply failed, falling back to text:', err.message);
    return sendText(text);
  }
}

/**
 * Reply in the same shape you were spoken to: voice note back for a voice
 * note, text back for text.
 */
export async function reply(text, { asVoice = false } = {}) {
  return asVoice ? sendVoice(text) : sendText(text);
}
