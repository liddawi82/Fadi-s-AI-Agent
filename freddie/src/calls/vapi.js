// Placing calls through Vapi.
//
// Vapi runs the live conversation — it listens, thinks, speaks, and handles
// interruptions. Freddie hands it a goal and a personality; Vapi does the
// talking and calls back here when it needs a tool or when the call ends.

import { config } from '../config.js';
import { callSystemPrompt } from '../brain/prompts.js';
import { log } from '../util/log.js';

const API = 'https://api.vapi.ai';

// Emergency and sensitive numbers Freddie must never dial, regardless of what
// any instruction says. Checked against the digits of the destination.
const BLOCKED = [
  '911', '112', '999', '000', '110', '119',   // emergency, various countries
  '191', '193', '199',                        // Jordan: police, fire, ambulance
  '988',                                      // US crisis line
];

export function isBlockedNumber(phone) {
  const digits = String(phone).replace(/\D/g, '');
  // Short numbers are almost always services, not people.
  if (digits.length <= 5 && BLOCKED.some((b) => digits.endsWith(b))) return true;
  return BLOCKED.includes(digits);
}

/**
 * The assistant definition sent with each call. Everything about how Freddie
 * sounds and behaves on the phone is here.
 */
function buildAssistant({ goal, language, calleeName, constraints }) {
  return {
    name: 'Freddie',
    firstMessageMode: 'assistant-speaks-first',

    // A bare "hello" leaves both sides waiting for the other, which reads as a
    // broken line. Saying who he is straight away fills the gap and gets the
    // disclosure out of the way in the same breath.
    firstMessage:
      language === 'ar'
        ? `مرحبا، أنا فريدي، مساعد ${config.owner.name}. معك دقيقة؟`
        : `Hi, this is Freddie — I'm ${config.owner.name}'s assistant. Do you have a moment?`,

    // Vapi plays fake call-centre ambience on phone calls by DEFAULT. It makes
    // Freddie sound like a room full of telemarketers. Off.
    backgroundSound: 'off',

    // How long he waits after you stop talking before he starts. The default
    // leaves an awkward beat; this is closer to how people actually converse.
    startSpeakingPlan: { waitSeconds: 0.4 },

    model: {
      provider: 'openai',
      model: config.openai.model,
      temperature: 0.6,
      messages: [{ role: 'system', content: callSystemPrompt({ goal, language, calleeName, constraints }) }],
      tools: [
        {
          type: 'function',
          async: false,
          server: {
            url: `${config.publicUrl}/vapi/tools`,
            ...(config.vapi.webhookSecret ? { secret: config.vapi.webhookSecret } : {}),
          },
          function: {
            name: 'ask_owner',
            description:
              "Ask the owner a question while the call is live, when the answer changes whether the goal can be met. Use sparingly — only for real decisions, never for information you could reasonably assume. Tell the other person to hold on before calling this.",
            parameters: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'A short, specific question. Include the options if there are options.',
                },
              },
              required: ['question'],
            },
          },
        },
        {
          type: 'function',
          async: false,
          server: {
            url: `${config.publicUrl}/vapi/tools`,
            ...(config.vapi.webhookSecret ? { secret: config.vapi.webhookSecret } : {}),
          },
          function: {
            name: 'note_task',
            description:
              'Write down a phone call you have been asked to make. Use this EVERY time someone on this call asks you to ring somebody — you cannot dial while you are on the line, so this is how the request actually gets done. Never say you have called someone unless you have used this tool. After using it, say you will handle it as soon as this call ends.',
            parameters: {
              type: 'object',
              properties: {
                to: {
                  type: 'string',
                  description: 'The number to call, in full international form. If you were not given a number, say so and do not guess.',
                },
                goal: {
                  type: 'string',
                  description: 'What that call must achieve, in enough detail to act on without you.',
                },
                callee_name: { type: 'string', description: 'Who is being called.' },
                language: { type: 'string', enum: ['en', 'ar', 'auto'] },
              },
              required: ['to', 'goal'],
            },
          },
        },
      ],
    },

    // Pin the transcriber to the call's language wherever we know it.
    //
    // Leaving it on 'multi' sounds appealing but is measurably worse: the
    // detector re-decides constantly, so a Jordanian speaker gets transcribed
    // as garbled English, Freddie answers in English, and the call drifts.
    // A pinned language is far more accurate. 'multi' is only used when we
    // genuinely don't know who's answering.
    transcriber: {
      provider: config.vapi.transcriberProvider,
      model: config.vapi.transcriberModel,
      language:
        language === 'ar' ? 'ar'
        : language === 'en' ? 'en'
        : config.vapi.transcriberLanguage,
    },

    voice: {
      provider: config.vapi.voiceProvider,
      voiceId: config.vapi.voiceId,
      model: config.vapi.voiceModel,
    },

    // Recording off by default: several US states require every party to
    // consent to a recorded call. Freddie works from the live transcript.
    artifactPlan: { recordingEnabled: false, transcriptPlan: { enabled: true } },

    server: {
      url: `${config.publicUrl}/vapi/events`,
      ...(config.vapi.webhookSecret ? { secret: config.vapi.webhookSecret } : {}),
    },
    serverMessages: ['end-of-call-report', 'status-update'],

    // Was 20 and hung up on real pauses. People need longer than that to think,
    // look something up, or go and check the book.
    silenceTimeoutSeconds: 45,
    maxDurationSeconds: 600,

    // No endCallMessage on purpose. It was a fixed string picked from the
    // language the call STARTED in, so an English conversation could end with
    // an Arabic farewell. Freddie says goodbye himself, in whatever language
    // the conversation actually ended up in.
  };
}

/**
 * Place an outbound call.
 * @returns {Promise<{id: string}>} the Vapi call record
 */
export async function placeCall({ to, goal, language = 'auto', calleeName = '', constraints = '' }) {
  if (!config.vapi.phoneNumberId) {
    throw new Error(
      'VAPI_PHONE_NUMBER_ID is not set, so Freddie has no line to call out on. ' +
      'In the Vapi dashboard under Phone Numbers, either create a free Vapi number ' +
      '(no payment method needed) or import your Twilio number, then paste its ID into Railway.'
    );
  }
  if (isBlockedNumber(to)) {
    throw new Error('That number is an emergency or crisis line. Freddie will not dial it.');
  }
  if (!config.publicUrl) {
    throw new Error(
      "PUBLIC_URL is not set, so Vapi has no way to reach Freddie back. Paste your Railway URL into the PUBLIC_URL variable and redeploy."
    );
  }

  const body = {
    phoneNumberId: config.vapi.phoneNumberId,
    customer: { number: to },
    assistant: buildAssistant({ goal, language, calleeName, constraints }),
  };

  const res = await fetch(`${API}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.vapi.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    log.error('Vapi refused the call:', res.status, text.slice(0, 400));
    throw new Error(`Vapi wouldn't place the call (${res.status}). ${text.slice(0, 200)}`);
  }

  const call = JSON.parse(text);
  log.ok(`Calling ${to} — Vapi call ${call.id}`);
  return call;
}

/** Fetch a call's current state, used when you ask "what happened?". */
export async function getCallStatus(callId) {
  const res = await fetch(`${API}/call/${callId}`, {
    headers: { Authorization: `Bearer ${config.vapi.apiKey}` },
  });
  if (!res.ok) return null;
  return res.json();
}
