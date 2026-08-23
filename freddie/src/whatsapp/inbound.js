// Handles every WhatsApp message that arrives.

import { config, normalisePhone } from '../config.js';
import { think } from '../brain/agent.js';
import { transcribeVoiceNote } from './transcribe.js';
import { reply, sendText } from './send.js';
import { deliverAnswer, isWaiting, pendingQuestion } from '../calls/pending.js';
import { log } from '../util/log.js';

export async function handleInbound(body) {
  const from = normalisePhone(body.From);
  const isVoiceNote = Number(body.NumMedia || 0) > 0 && String(body.MediaContentType0 || '').startsWith('audio');

  // ── Only the owner may command Freddie ────────────────────────────────────
  // This is the single most important line in the project. Without it, anyone
  // who learns Freddie's number can make him place phone calls.
  if (from !== config.owner.whatsapp) {
    log.warn(`Ignoring a message from ${from} — not the owner.`);
    return;
  }

  // ── Work out what was said ────────────────────────────────────────────────
  let text = (body.Body || '').trim();

  if (isVoiceNote) {
    try {
      text = await transcribeVoiceNote(body.MediaUrl0, body.MediaContentType0);
    } catch (err) {
      log.error('Could not transcribe the voice note:', err.message);
      await sendText("I couldn't make out that voice note — can you send it again, or type it?");
      return;
    }
    if (!text) {
      await sendText("That voice note came through empty. Try again?");
      return;
    }
  }

  if (!text) return;

  // ── Is Freddie mid-call, waiting on an answer? ────────────────────────────
  // If so, this message is the answer to his question, not a new instruction.
  if (isWaiting()) {
    const question = pendingQuestion();
    if (deliverAnswer(text)) {
      log.ok(`Owner answered "${question}" with "${text.slice(0, 50)}"`);
      return; // Freddie is on the phone; he'll report back when the call ends.
    }
  }

  // ── Otherwise, think about it ─────────────────────────────────────────────
  log.info(`Owner: "${text.slice(0, 100)}"`);
  const answer = await think(text);
  await reply(answer, { asVoice: isVoiceNote });
}
