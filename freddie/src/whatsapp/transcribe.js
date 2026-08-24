// Turning a WhatsApp voice note into text.
//
// This runs after the fact rather than live, which means it can use a more
// careful model than the one on the phone call. That matters for Jordanian
// Arabic, where dialect costs accuracy.

import OpenAI from 'openai';
import { config } from '../config.js';
import { log } from '../util/log.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Download a Twilio-hosted media file. Twilio media URLs sit behind the
 * account's own credentials, so this authenticates as the account.
 *
 * Twilio sometimes fires the inbound webhook before the media is actually
 * fetchable. A single 1.2s retry was tried first and wasn't enough — it still
 * 404'd in practice, so this racier propagation can apparently outlast that.
 * Backing off across several attempts (1s, 2s, 4s, 8s — nearly 15s of total
 * patience) gives Twilio much more room to catch up before this gives up and
 * tells the owner to resend, which is the annoying fallback.
 */
async function fetchMedia(url) {
  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  const attempt = () => fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  const delaysMs = [1000, 2000, 4000, 8000];

  let res = await attempt();
  for (let i = 0; !res.ok && (res.status === 404 || res.status >= 500) && i < delaysMs.length; i++) {
    log.warn(`Voice note media not ready yet (${res.status}) — retrying in ${delaysMs[i]}ms (attempt ${i + 2}/${delaysMs.length + 1}).`);
    await new Promise((r) => setTimeout(r, delaysMs[i]));
    res = await attempt();
  }
  if (!res.ok) throw new Error(`Twilio returned ${res.status} for the voice note`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * @param {string} mediaUrl   the MediaUrl0 value from Twilio's webhook
 * @param {string} contentType e.g. "audio/ogg"
 * @returns {Promise<string>} the transcript
 */
export async function transcribeVoiceNote(mediaUrl, contentType = 'audio/ogg') {
  const audio = await fetchMedia(mediaUrl);

  const ext = contentType.includes('mpeg') ? 'mp3'
    : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a'
    : contentType.includes('wav') ? 'wav'
    : 'ogg';

  const file = new File([audio], `note.${ext}`, { type: contentType });

  const result = await openai.audio.transcriptions.create({
    file,
    model: config.openai.transcribeModel,
    // No language hint on purpose — forcing 'ar' or 'en' breaks the common
    // case where a sentence contains both.
    prompt:
      'A short voice note to a personal assistant. May be in Jordanian Arabic, ' +
      'American English, or a mix of both. May contain names of people and restaurants.',
  });

  const text = (result.text || '').trim();
  log.info(`Voice note transcribed: "${text.slice(0, 80)}"`);
  return text;
}
