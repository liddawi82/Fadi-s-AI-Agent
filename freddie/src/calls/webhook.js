// What Vapi sends back to Freddie: tool calls made during a live call, and
// the report when a call ends.

import { config } from '../config.js';
import { askAndWait } from './pending.js';
import { noteTask, drainTasks } from './tasks.js';
import { placeCall, isBlockedNumber } from './vapi.js';
import { normalisePhone, isDialable } from '../config.js';
import { sendText, reply } from '../whatsapp/send.js';
import { summariseCall } from '../brain/agent.js';
import { findRestaurants } from '../places.js';
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
    } else if (name === 'suggest_restaurants') {
      const found = await findRestaurants(args.location, args.cuisine);
      if (!found.ok) {
        results.push({ toolCallId: id, result: found.message });
      } else {
        const list = found.restaurants
          .map((r) => {
            const bits = [r.name];
            if (r.rating) bits.push(`rated ${r.rating}${r.reviewCount ? ` (${r.reviewCount} reviews)` : ''}`);
            if (r.address) bits.push(r.address);
            bits.push(r.phone ? `phone: ${r.phone}` : 'no phone number on file');
            return bits.join(' — ');
          })
          .join('; ');
        results.push({
          toolCallId: id,
          result: `Here's what came up, best-reviewed first: ${list}. Mention a couple of these by name — don't read out addresses or numbers unless asked, and don't claim you've booked anything. If asked to book one, use note_task with the phone number shown above (only if one is listed) — you cannot dial while on this line.`,
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
    // The language the call actually ran in, as resolved and recorded when it
    // was placed — not guessed from whether the goal text happens to contain
    // Arabic script, which doesn't reliably track what was actually spoken.
    language: stored?.language === 'ar' ? 'ar' : 'en',
    isSelfCall: Boolean(stored?.to) && stored.to === config.owner.whatsapp,
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
    // The same daily ceiling applies here as it does to calls placed directly
    // from WhatsApp — without this, a task noted mid-call could dial past
    // MAX_CALLS_PER_DAY, since this loop bypasses that check entirely otherwise.
    if (memory.callsToday() >= config.behaviour.maxCallsPerDay) {
      log.warn(`Skipping follow-up call to ${task.to} — daily limit (${config.behaviour.maxCallsPerDay}) reached.`);
      await sendText(
        `I was going to call ${task.calleeName || task.to} as promised, but we've hit today's call limit (${config.behaviour.maxCallsPerDay}). Raise MAX_CALLS_PER_DAY if you want me to go ahead anyway.`
      );
      continue;
    }
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
        language: placed.language,
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
