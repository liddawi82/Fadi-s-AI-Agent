// Freddie's reasoning loop: read the message, decide, use tools, answer.

import OpenAI from 'openai';
import { config } from '../config.js';
import { whatsappSystemPrompt } from './prompts.js';
import { toolDefinitions, runTool } from './tools.js';
import * as memory from '../memory/store.js';
import { log } from '../util/log.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const MAX_STEPS = 6; // tool rounds before he must answer with words

// GPT-5-family "reasoning" models refuse to mix function tools with their
// default reasoning effort on the plain chat.completions endpoint — OpenAI's
// own fix is to pass reasoning_effort: 'none' when tools are in play. Without
// this, every single tool call (place_call, note_task, everything Freddie
// actually DOES) fails outright and he answers with the generic error line.
export function needsReasoningEffortNone(model) {
  return /^gpt-5/.test(String(model || ''));
}

// Which language THIS reply must be written in — decided here in code, from
// the message that just arrived, rather than left to the model to judge from
// the whole conversation. The model-judgement version of this rule was tried
// twice and both times drifted into Arabic on plain English messages once the
// conversation had a few Arabic replies in it. A cheap character scan on the
// one message that matters doesn't have that failure mode.
const ARABIC_CHAR = /[؀-ۿ]/;
const LATIN_LETTER = /[A-Za-z]/;

export function detectReplyLanguage(text) {
  const hasArabic = ARABIC_CHAR.test(text || '');
  const hasLatin = LATIN_LETTER.test(text || '');
  if (hasArabic && hasLatin) return 'mixed';
  if (hasArabic) return 'ar';
  return 'en'; // includes empty, numbers-only, or punctuation-only messages
}

/**
 * Handle one message from the owner.
 * @param {string} text what he said (typed, or transcribed from a voice note)
 * @returns {Promise<string>} Freddie's reply
 */
export async function think(text) {
  memory.appendTurn('user', text);

  const replyLanguage = detectReplyLanguage(text);
  const languageLabel =
    replyLanguage === 'ar' ? 'Arabic' : replyLanguage === 'mixed' ? 'a mix of English and Arabic' : 'English';

  const messages = [
    {
      role: 'system',
      content: whatsappSystemPrompt({
        contacts: memory.listContacts(),
        recentCalls: memory.recentCalls(6),
        prefs: memory.preferences(),
        requireConfirmation: config.behaviour.requireConfirmation,
        replyLanguage,
      }),
    },
    ...memory.conversationHistory(),
  ];

  // A single instruction at the TOP of a long conversation isn't enough —
  // once history has a run of Arabic replies in it, that pattern outweighs
  // one line from several messages back. Re-asserting the language as the
  // very LAST thing the model sees, right before it answers, holds up far
  // better against that pull. Rebuilt fresh each step (not pushed into
  // `messages`) so it always stays last, even after tool calls/results are
  // appended below, and never pollutes the saved conversation history.
  const languageReminder = {
    role: 'system',
    content: `Reminder, decided in code from his latest message, not by you: your next reply to him must be written in ${languageLabel}. This overrides any pull from the Arabic (or English) replies earlier in this conversation.`,
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [...messages, languageReminder],
        tools: toolDefinitions,
        // Lower than a typical chat temperature on purpose: deciding whether
        // to actually call place_call is a decide-and-execute step, not
        // creative writing, and this was seen to sometimes skip the tool call
        // and just claim "calling you now" in its place — less randomness
        // here makes that kind of skip less likely.
        temperature: 0.3,
        ...(needsReasoningEffortNone(config.openai.model) ? { reasoning_effort: 'none' } : {}),
      });
    } catch (err) {
      log.error('The model call failed:', err.message);
      return "Something went wrong on my end and I couldn't work that out. Try me again in a moment.";
    }

    const choice = response.choices[0].message;
    messages.push(choice);

    const calls = choice.tool_calls || [];
    if (calls.length === 0) {
      const answer = (choice.content || '').trim() || 'Done.';
      memory.appendTurn('assistant', answer);
      return answer;
    }

    // Run every tool the model asked for, in parallel where it asked for several.
    const results = await Promise.all(
      calls.map(async (call) => {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* the model occasionally emits malformed JSON; treat as empty */
        }
        let result;
        try {
          result = await runTool(call.function.name, args);
        } catch (err) {
          log.error(`Tool ${call.function.name} threw:`, err.message);
          result = { ok: false, message: err.message };
        }
        return {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        };
      })
    );

    messages.push(...results);
  }

  const fallback = "I got a bit tangled up working that out. Can you tell me again, more simply?";
  memory.appendTurn('assistant', fallback);
  return fallback;
}

/**
 * Write the short report you get after a call ends. Kept separate from the
 * main loop so it can't accidentally trigger another call.
 */
export async function summariseCall({ calleeName, goal, transcript, summary, endedReason, language, isSelfCall }) {
  const prompt = `
You are Freddie. A call you placed has just ended. Write a short note to
${config.owner.name} telling him what happened. You are writing AS Freddie, TO him —
never in his voice, and never as though you were the person called.
${isSelfCall ? `
THIS CALL WAS TO ${config.owner.name} HIMSELF — he is both the person you rang
AND the person reading this report. Write as if speaking directly to him:
"you said...", "we didn't land on...", never "${calleeName || 'he'} said..." or
his name in the third person. Referring to him in the third person here reads
as if you're describing a stranger, which is confusing since it was him.` : ''}

RULES — these matter more than style:
- State ONLY what is in the transcript below. If the transcript is empty or
  says almost nothing, say the call didn't get anywhere. Do not invent a
  conversation, an outcome, or an agreement.
- NEVER claim you called someone else, passed on a message, or arranged
  anything, unless this transcript shows it happening.
- If the goal was not achieved, say so plainly in the first sentence.
- If you agreed during the call to ring somebody afterwards, say you're about
  to do it — not that it's done.
- Two or three sentences. Lead with the outcome.

Write in ${language === 'ar' ? 'Jordanian Arabic' : 'American English'}.

Who was called: ${calleeName || 'unknown'}
What it was for: ${goal || 'unknown'}
How it ended: ${endedReason || 'unknown'}
Vapi's own summary: ${summary || '(none)'}

TRANSCRIPT:
${(transcript || '(no transcript — the call produced no usable audio)').slice(0, 6000)}
`.trim();

  try {
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    return (res.choices[0].message.content || '').trim();
  } catch (err) {
    log.error('Could not summarise the call:', err.message);
    return `The call to ${calleeName || 'them'} ended (${endedReason || 'unknown reason'}), but I couldn't write up what happened.`;
  }
}
