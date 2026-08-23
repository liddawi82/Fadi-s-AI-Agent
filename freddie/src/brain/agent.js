// Freddie's reasoning loop: read the message, decide, use tools, answer.

import OpenAI from 'openai';
import { config } from '../config.js';
import { whatsappSystemPrompt } from './prompts.js';
import { toolDefinitions, runTool } from './tools.js';
import * as memory from '../memory/store.js';
import { log } from '../util/log.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const MAX_STEPS = 6; // tool rounds before he must answer with words

/**
 * Handle one message from the owner.
 * @param {string} text what he said (typed, or transcribed from a voice note)
 * @returns {Promise<string>} Freddie's reply
 */
export async function think(text) {
  memory.appendTurn('user', text);

  const messages = [
    {
      role: 'system',
      content: whatsappSystemPrompt({
        contacts: memory.listContacts(),
        recentCalls: memory.recentCalls(6),
        prefs: memory.preferences(),
      }),
    },
    ...memory.conversationHistory(),
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await openai.chat.completions.create({
        model: config.openai.model,
        messages,
        tools: toolDefinitions,
        temperature: 0.5,
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
export async function summariseCall({ calleeName, goal, transcript, summary, endedReason, language }) {
  const prompt = `
You are Freddie. A call you placed has just ended. Tell ${config.owner.name} what happened,
in ${language === 'ar' ? 'Jordanian Arabic' : 'American English'}.

Two or three sentences. Lead with the outcome, not the process. If the goal was met, say
exactly what was agreed — day, time, name, any condition. If it was not met, say so plainly
and say why. Never imply something was arranged when it wasn't.

Who was called: ${calleeName || 'unknown'}
What the call was for: ${goal || 'unknown'}
How the call ended: ${endedReason || 'unknown'}
Vapi's own summary: ${summary || '(none)'}

Transcript:
${(transcript || '(no transcript)').slice(0, 6000)}
`.trim();

  try {
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });
    return (res.choices[0].message.content || '').trim();
  } catch (err) {
    log.error('Could not summarise the call:', err.message);
    return `The call to ${calleeName || 'them'} ended (${endedReason || 'unknown reason'}), but I couldn't write up what happened.`;
  }
}
