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

// Backstop for a bug that two prompt-only fixes failed to stop: the model
// sometimes answers "Calling you now, Fadi..." (or similar) WITHOUT ever
// having invoked place_call in that same turn. Root cause — persisted history
// only stores {role, content}, never tool-call detail (see store.js), so the
// model's own past fake replies look, in its own context, exactly like real
// ones that happened to skip the tool. That teaches it, via plain pattern
// imitation, to keep skipping it. A prompt instruction competes with that
// pattern and can lose; this check doesn't compete — it inspects what
// actually happened this turn and refuses to let a false claim through
// regardless of why the model produced it.
//
// This has now leaked twice through PHRASING rather than through logic. The
// first version caught only present tense ("calling you now", "I'm calling").
// It was widened to "I'll call" / "going to call" / "let me call" after a call
// to Chris silently never happened — and then leaked again, live, on "I'm
// about to call Chris", which none of those literals cover.
//
// Enumerating ways to say "I am going to call" is a losing game, so this is no
// longer a list of phrases. It is a shape: a first-person subject, then a
// calling verb close behind it, with negations and hand-offs excluded so
// "I can't call him" and "I'll ask him to call you" don't trip it.
const SELF_REF = String.raw`\b(?:i|i['’]?m|i am|i['’]?ll|i will|let me|lemme)\b`;

// If any of these sits between the subject and the verb, it isn't a claim that
// Freddie is about to call: he's saying he can't, hasn't, or that somebody
// ELSE should.
const NOT_A_CLAIM = String.raw`can'?t|cannot|can not|won'?t|will not|do(?:es)? ?n'?t|di ?d ?n'?t|have ?n'?t|has ?n'?t|couldn'?t|wasn'?t|am not|never|unable|ask`;

const CALL_VERB = String.raw`\b(?:call|calling|ring|ringing|dial|dialing|dialling|phone|phoning)\b`;

const FAKE_CALLING_CLAIM_RE = new RegExp(
  // "I'm about to call Chris", "I'll go ahead and ring her", "let me call him"
  `${SELF_REF}(?:(?!${NOT_A_CLAIM})[^.!?\\n]){0,40}?${CALL_VERB}` +
  // Subjectless commitments: "Calling Chris now.", "Ringing him shortly."
  `|\\b(?:calling|ringing|dialing|dialling|phoning)\\b[^.!?\\n]{0,30}?\\b(?:now|shortly|right away|as we speak|in a (?:sec|second|moment|minute))\\b` +
  `|\\bthe line is ringing\\b|\\b(?:dialling|dialing) now\\b` +
  // Arabic equivalents.
  `|عم\\s*[أا]تصل|رح\\s*[أا]تصل|ح[أا]?تصل|بدي\\s*[أا]تصل|جاري\\s*الاتصال|بتصل\\s*فيك|عم\\s*بتصل`,
  'i'
);

// How many times one turn may be sent back to rewrite an unbacked claim before
// we stop asking. Without a cap, a model that keeps reasserting the same claim
// burns every remaining step and lands on the generic "I got tangled up"
// fallback, which tells him nothing useful.
const MAX_FAKE_CLAIM_NUDGES = 2;

// The MIRROR of the guard above, and it exists because of a real failure.
//
// He sent an Arabic voice note: "مرحبا فريدي، كلمني بدي أحكي معك بالعربي،
// وبلش معاي قولي مرحبا فادي، وقولي حابب أطمن على ابنك سمعت إنه ممغوص" — call
// me, and open the call by saying hello and asking after my son. Freddie
// replied in chat with exactly that greeting and never invoked place_call.
//
// The claim guard could not catch it: he never said he was calling, so there
// was no false claim to block. Two things pulled him there — كلمني means both
// "phone me" and "talk to me", and قولي ("say to me") reads as an instruction
// to say it right here, especially since every reply he writes is auto-sent
// to him as a WhatsApp message.
//
// Unlike the claim guard, which REFUSES to let a falsehood through, this one
// only asks the model to look again. A call REQUEST is far harder to detect
// reliably than a call CLAIM — "why didn't you call me", "call me later",
// "don't call him" all contain the words — so the nudge below is written to be
// declined. If he was asking about a past call, or something genuinely is
// missing, the model answers normally and that answer stands.
const CALL_REQUEST = String.raw`\b(?:call|ring|phone|dial)\b[^.!?\n]{0,20}?\b(?:me|him|her|them|us|back)\b`;
const GIVE_A_CALL = String.raw`\bgive (?:me|him|her|them) a (?:call|ring|buzz)\b`;
// Levantine: كلمني، اتصل فيي/فيه، رنلي، رن علي، خابرني، دقلي، اطلبلي
const CALL_REQUEST_AR = String.raw`كلمن[يا]|[إا]تصل\s*(?:في|ب|ع)|رن+\s*(?:ل[يه]|عل[يى])|خابرن[يا]|دق+\s*ل[يه]|اطلبل[يه]`;

// Any of these shortly before the verb means it is NOT a request to dial now:
// a past call, a refusal, or a hypothetical.
const NOT_A_REQUEST = String.raw`did ?n'?t|does ?n'?t|do ?n'?t|was ?n'?t|have ?n'?t|has ?n'?t|never|why|instead of|no need to|ما |لا |ليش|مش`;

const OWNER_ASKED_FOR_CALL_RE = new RegExp(
  `(?:${NOT_A_REQUEST})[^.!?\\n]{0,20}?(?:${CALL_REQUEST}|${CALL_REQUEST_AR})` +
  `|(${CALL_REQUEST}|${GIVE_A_CALL}|${CALL_REQUEST_AR})`,
  'i'
);

// Deferred requests ("call me later", "بعدين") aren't for now, and nudging on
// them would be noise.
const DEFERRED_RE = /\b(?:later|tomorrow|tonight|in an hour|in a bit|next week)\b|بعدين|بكرا|بعد شوي/i;

// One nudge only. This guard asks a question rather than blocking a lie, so
// pressing it a second time would just be arguing with the model.
const MAX_MISSED_CALL_NUDGES = 1;

/**
 * Did his message ask for a call to be placed NOW?
 *
 * Capture group 1 is only set by the un-negated branch, so a match that came
 * from the negated branch ("why didn't you call me") reports false.
 */
export function ownerAskedForACall(text) {
  const t = String(text || '');
  if (DEFERRED_RE.test(t)) return false;
  const m = OWNER_ASKED_FOR_CALL_RE.exec(t);
  if (!m || !m[1]) return false;

  // The negation can also come AFTER the verb — "I asked you to call me but
  // you didn't", "call me? you never did". A complaint about a call that
  // never happened is not a request to place one now.
  const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
  return !new RegExp(NOT_A_REQUEST, 'i').test(after);
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

  // True once place_call has actually been invoked (and returned) at any
  // point in this turn. Checked below before any no-tool-calls answer is
  // allowed to claim a call happened.
  let calledPlaceCallThisTurn = false;

  // How many times this turn has been sent back to rewrite an unbacked claim.
  let fakeClaimNudges = 0;

  // Whether his message asked for a call, and whether we've already pointed
  // that out once this turn.
  const askedForCall = ownerAskedForACall(text);
  let missedCallNudges = 0;

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

      if (!calledPlaceCallThisTurn && FAKE_CALLING_CLAIM_RE.test(answer)) {
        log.warn(`Blocked a commitment-to-call reply with no place_call this turn: "${answer.slice(0, 120)}"`);

        // Asked twice and still claiming it? Stop asking. Returning the claim
        // would be a lie, and looping on to the generic "I got tangled up"
        // fallback would tell him nothing — so say plainly what didn't happen.
        if (++fakeClaimNudges > MAX_FAKE_CLAIM_NUDGES) {
          log.error('Model kept committing to a call after correction; answering honestly instead.');
          const honest =
            "I haven't actually placed that call — something went wrong on my end. " +
            "Send me the number and what you'd like me to say, and I'll get it done.";
          memory.appendTurn('assistant', honest);
          return honest;
        }

        messages.push({
          role: 'system',
          content:
            "That answer says a call is happening or is about to happen, but place_call was never invoked this turn — so it would be false. " +
            "If you have what you need (who to call and what for), call place_call right now, then report what it returned. " +
            "If you don't have enough to place the call yet, ask him for what's missing instead of saying you're calling.",
        });
        continue; // give the model another step to either really call or rewrite honestly
      }

      // He asked for a call and the turn is ending without one. Point it out
      // once. Phrased so the model can say no: only it can tell a live request
      // from a question about a past call.
      if (askedForCall && !calledPlaceCallThisTurn && missedCallNudges < MAX_MISSED_CALL_NUDGES) {
        missedCallNudges++;
        log.warn(`Owner's message looked like a call request but no place_call ran; asking once: "${answer.slice(0, 120)}"`);
        messages.push({
          role: 'system',
          content:
            "His message looks like it asked you to place a call, and this turn is about to end without place_call having been invoked. " +
            "If he did ask you to ring someone now, call place_call — and note that when he tells you what to SAY on the call " +
            "(\"start by saying hello\", \"قولي مرحبا\", \"ask how his son is\"), that wording is the content of the CALL: put it in the goal. " +
            "Do not perform those lines here in the chat — writing them to him is not making the call. " +
            "If he was asking about a call that already happened, telling you not to call, or you're still missing the number or the goal, " +
            "then your answer is right as it stands — send it unchanged.",
        });
        continue;
      }

      memory.appendTurn('assistant', answer);
      return answer;
    }

    // Run every tool the model asked for, in parallel where it asked for several.
    if (calls.some((call) => call.function.name === 'place_call')) {
      calledPlaceCallThisTurn = true;
    }

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
