// What Vapi sends back to Freddie: tool calls made during a live call, and
// the report when a call ends.

import { config } from '../config.js';
import { askAndWait } from './pending.js';
import { sendText, reply } from '../whatsapp/send.js';
import { summariseCall } from '../brain/agent.js';
import * as memory from '../memory/store.js';
import { log } from '../util/log.js';

/**
 * Confirms a request really came from Vapi and not from someone who guessed
 * Freddie's URL. Vapi sends the shared secret in the x-vapi-secret header.
 */
export function verifyVapi(req) {
  if (!config.vapi.webhookSecret) return true; // not configured; allow but warn elsewhere
  const sent = req.get('x-vapi-secret') || req.get('X-Vapi-Secret') || '';
  return sent === config.vapi.webhookSecret;
}

/**
 * A tool call from Freddie while he is on the phone.
 * Vapi expects: { results: [{ toolCallId, result }] }
 */
export async function handleToolCall(message) {
  const list = message?.toolCallList || message?.toolCalls || [];
  const results = [];

  for (const call of list) {
    const id = call.id || call.toolCallId;
    const name = call.name || call.function?.name;
    let args = call.arguments || call.function?.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }

    if (name === 'ask_owner') {
      const question = args.question || 'A question came up on the call.';
      log.info(`Freddie is asking mid-call: "${question}"`);

      const { promise } = askAndWait(question);
      await sendText(`📞 On the call now — ${question}`);

      const answer = await promise;
      results.push({
        toolCallId: id,
        result: answer
          ? `${config.owner.name} says: ${answer}`
          : `${config.owner.name} didn't reply in time. Use your best judgement, lean towards accepting a reasonable option, and tell him afterwards what you chose.`,
      });
    } else {
      results.push({ toolCallId: id, result: `Unknown tool "${name}".` });
    }
  }

  return { results };
}

/** A call has ended — write it up and message the owner. */
export async function handleEndOfCall(message) {
  const callId = message?.call?.id;
  const stored = callId ? memory.getCall(callId) : null;

  const transcript = message?.artifact?.transcript || message?.transcript || '';
  const summary = message?.analysis?.summary || message?.summary || '';
  const endedReason = message?.endedReason || '';

  log.info(`Call ${callId} ended (${endedReason})`);

  const text = await summariseCall({
    calleeName: stored?.name || stored?.to || '',
    goal: stored?.goal || '',
    transcript,
    summary,
    endedReason,
    language: /[؀-ۿ]/.test(stored?.goal || '') ? 'ar' : 'en',
  });

  if (callId) {
    memory.updateCall(callId, {
      status: 'ended',
      endedAt: new Date().toISOString(),
      endedReason,
      outcome: text.slice(0, 300),
    });
  }

  await reply(text, { asVoice: config.behaviour.voiceReplies });
}

/** Route a Vapi server message to the right handler. */
export async function handleVapiEvent(message) {
  switch (message?.type) {
    case 'end-of-call-report':
      return handleEndOfCall(message);
    case 'status-update':
      if (message?.call?.id) {
        memory.updateCall(message.call.id, { status: message.status || 'unknown' });
      }
      return null;
    default:
      return null;
  }
}
