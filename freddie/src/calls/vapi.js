// Placing calls through Vapi.
//
// Vapi runs the live conversation — it listens, thinks, speaks, and handles
// interruptions. Freddie hands it a goal and a personality; Vapi does the
// talking and calls back here when it needs a tool or when the call ends.

import { config, normalisePhone } from '../config.js';
import { callSystemPrompt } from '../brain/prompts.js';
import * as memory from '../memory/store.js';
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
function buildAssistant({ to, goal, language, calleeName, constraints }) {
  // Is Freddie about to talk to the owner himself? Only he may ask for a
  // follow-up call, so this decides what Freddie is allowed to promise when
  // someone on the line asks him to ring a third party. The backend enforces
  // the same rule independently in calls/webhook.js — this flag only keeps
  // Freddie's wording honest about what will actually happen.
  const ownerOnLine = normalisePhone(to) === config.owner.whatsapp;

  // Whatever you've already recorded about this person, so Freddie can pitch
  // the call the way the relationship deserves rather than talking to your
  // brother the way he'd talk to a bank. Derived here, so both routes to a
  // call — from WhatsApp, and a follow-up noted mid-call — get it without
  // anyone having to remember to pass it. No contact, or no note, and the
  // prompt simply omits the line and Freddie reads the room instead.
  const relationship = (memory.findContact(to)?.notes || '').trim();

  return {
    name: 'Freddie',
    firstMessageMode: 'assistant-speaks-first',

    // A bare "hello" leaves both sides waiting for the other, which reads as a
    // broken line. Saying who he is straight away fills the gap and gets the
    // disclosure out of the way in the same breath.
    // Greet them by name when we know it. Being addressed by name is the
    // difference between sounding like a robocall and sounding like someone
    // who was actually asked to ring you.
    firstMessage: (() => {
      const owner = config.owner.name;
      const name = (calleeName || '').trim();

      if (language === 'ar') {
        return name
          ? `مرحبا، معي ${name}؟ أنا فريدي، مساعد ${owner}. معك دقيقة؟`
          : `مرحبا، أنا فريدي، مساعد ${owner}. معك دقيقة؟`;
      }
      return name
        ? `Hi, is this ${name}? It's Freddie, ${owner}'s assistant. Do you have a moment?`
        : `Hi, this is Freddie — I'm ${owner}'s assistant. Do you have a moment?`;
    })(),

    // Vapi plays fake call-centre ambience on phone calls by DEFAULT. It makes
    // Freddie sound like a room full of telemarketers. Off.
    backgroundSound: 'off',

    // How long he waits after you stop talking before he starts, PLUS how he
    // decides you're actually done. Without smartEndpointingPlan, Vapi falls
    // back to a flat silence timer — on a real phone line (breathing, filler
    // sounds, a beat while someone thinks) that reads either as Freddie going
    // silent until you prompt him, or as him jumping in mid-thought. The
    // 'vapi' provider reads the transcript itself to judge a real end-of-turn,
    // and it's the one Vapi recommends for non-English conversations, which
    // matters here since calls can run in Arabic.
    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: { provider: 'vapi' },
    },

    // Without this, ANY sound while Freddie is talking — a breath, static, a
    // stray "uh" — counts as an interruption (the default is 0 words). He
    // stops mid-sentence, then restarts from the top a second later, which is
    // exactly what "repeats himself" looks like from the other end. Requiring
    // a couple of real words before he yields, and treating short
    // acknowledgements as backchannel rather than a turn, fixes that without
    // making him slow to yield when someone genuinely interrupts.
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 1,
      acknowledgementPhrases: [
        'okay', 'ok', 'right', 'uh-huh', 'mm-hmm', 'mhm', 'yeah', 'yes', 'sure', 'got it', 'i see',
        'تمام', 'ايوا', 'ايه', 'اه', 'اوك', 'مممم', 'طيب', 'ماشي',
      ],
    },

    model: {
      provider: 'openai',
      model: config.openai.model,
      temperature: 0.6,
      messages: [{ role: 'system', content: callSystemPrompt({ goal, language, calleeName, constraints, ownerOnLine, relationship }) }],
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
            // The tool description, the system prompt, the tool's result and
            // the backend gate in calls/webhook.js must all describe the same
            // behaviour. Only the owner can cause a follow-up call to be
            // placed, so only the owner may be promised one.
            description: ownerOnLine
              ? `Write down a phone call ${config.owner.name} has asked you to make. Use this every time he asks you to ring somebody — you cannot dial while you are on this line, so this is how the request actually gets done, once this call ends. After using it, tell him you will handle it as soon as you hang up. Never say you have called someone unless it has actually happened.`
              : `Record a request when someone on this call asks you to ring somebody. You cannot make that call: a follow-up call needs ${config.owner.name}'s authorisation, and this tool only captures the request for him. After using it, tell them you will pass it on to ${config.owner.name} — do NOT promise that you or he will make the call, and never say a call has happened when it has not.`,
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
                language: { type: 'string', enum: ['en', 'ar'], description: "Omit for English (default). 'ar' only if you know they speak Arabic." },
              },
              required: ['to', 'goal'],
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
            name: 'suggest_restaurants',
            description:
              "Look up well-reviewed restaurants near a location that came up on this call — use it when the goal itself is finding somewhere to eat, or the person you're talking to mentions where they are and it becomes relevant. Returns 2-3 real, well-rated places to mention by name. This only SUGGESTS places — it does not book anything.",
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'A neighbourhood, address, landmark, or city — wherever "near" should be. Required.',
                },
                cuisine: {
                  type: 'string',
                  description: 'Optional — a type of food if one was mentioned, e.g. "Italian", "seafood".',
                },
              },
              required: ['location'],
            },
          },
        },
      ],
    },

    // Pin the transcriber to the call's language. Every call now runs in a
    // single, known language (no more bilingual "ask" mode), so a pinned
    // value is always correct and always more accurate than 'multi' — the
    // detector re-decides constantly, so a Jordanian speaker gets transcribed
    // as garbled English, Freddie answers in English, and the call drifts.
    transcriber: {
      provider: config.vapi.transcriberProvider,
      model: config.vapi.transcriberModel,
      language: language === 'ar' ? 'ar' : 'en',
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
export async function placeCall({ to, goal, language, calleeName = '', constraints = '' }) {
  // No language given, or 'auto'? Use the configured default (English,
  // unless Railway is set to default to Arabic) rather than guessing.
  if (!language || language === 'auto') language = config.vapi.defaultCallLanguage;
  if (!['en', 'ar'].includes(language)) language = 'en';
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
    assistant: buildAssistant({ to, goal, language, calleeName, constraints }),
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
  // Not part of Vapi's response — attached so callers can record the language
  // that was actually resolved and used (after the 'auto'/default fallback
  // above), rather than having to guess it again later from the call's goal
  // text, which doesn't reliably reflect what language the call ran in.
  call.language = language;
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
