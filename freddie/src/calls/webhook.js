// What Vapi sends back to Freddie: tool calls made during a live call, and
// the report when a call ends.

import { config } from '../config.js';
import { askAndWait } from './pending.js';
import { noteTask, drainTasks } from './tasks.js';
import { placeCall, isBlockedNumber } from './vapi.js';
import { normalisePhone, isDialable } from '../config.js';
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
    } else if (name === 'note_task') {
      const to = normalisePhone(args.to || '');
      // Blocked first: an emergency number is short, so it would otherwise trip
      // the dialable check and get refused for the wrong, less clear reason.
      if (isBlockedNumber(to)) {
        results.push({ toolCallId: id, result: 'That is an emergency line. Refuse, and say why.' });
      } else if (!isDialable(to)) {
        results.push({
          toolCallId: id,
          result:
            `"${args.to}" isn't a usable phone number — no network will accept it. Read it ` +
            `back to them digit by digit and get the whole thing, including the area or ` +
            `country code. Do NOT say you will call anyone until you have one that checks out.`,
        });
      } else {
        noteTask(message?.call?.id, {
          to,
          goal: args.goal || 'No goal given.',
          calleeName: args.callee_name || to,
          language: args.language || 'auto',
        });
        results.push({
          toolCallId: id,
          result: `Written down. You WILL ring ${args.callee_name || to} the moment this call ends. Tell them so — and do not say it has already happened.`,
        });
      }
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

  // Now do whatever he agreed to during the call. This is the step whose
  // absence let him claim he'd rung someone when he hadn't.
  const tasks = drainTasks(callId);
  for (const task of tasks) {
    try {
      const placed = await placeCall({
        to: task.to,
        goal: task.goal,
        language: task.language,
        calleeName: task.calleeName,
      });
      memory.recordCall({
        id: placed.id,
        to: task.to,
        name: task.calleeName,
        goal: task.goal,
        status: 'dialling',
      });
      await sendText(`Calling ${task.calleeName} now, as you asked.`);
    } catch (err) {
      log.error(`Follow-up call to ${task.to} failed:`, err.message);
      await sendText(`I couldn't reach ${task.calleeName} — ${err.message}`);
    }
  }
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
