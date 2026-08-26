// Reads Freddie's settings from the environment and fails loudly and clearly
// if something essential is missing, rather than crashing later with a
// confusing error in the middle of a phone call.

const REQUIRED = [
  ['OWNER_WHATSAPP', 'Your own WhatsApp number, e.g. +15551234567'],
  ['TWILIO_ACCOUNT_SID', 'From the Twilio Console home page, starts with AC'],
  ['TWILIO_AUTH_TOKEN', 'From the Twilio Console home page'],
  ['TWILIO_WHATSAPP_FROM', "Freddie's WhatsApp number"],
  ['OPENAI_API_KEY', 'From platform.openai.com, starts with sk-'],
  ['VAPI_API_KEY', 'From the Vapi dashboard, API Keys, Private Key'],
];

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalise a phone number to E.164-ish: a leading + and digits only. */
// The country code assumed when someone says a bare local number out loud.
// Freddie's world is mostly US, so '1' — override in Railway if that changes.
const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '');

export function normalisePhone(raw) {
  if (!raw) return '';
  const trimmed = String(raw).replace(/^whatsapp:/i, '').trim();
  const digits = trimmed.replace(/\D/g, '');

  // Someone reading a number aloud on the phone almost never says the country
  // code. Ten digits is a local number, not an E.164 one — before this,
  // "945 900 8800" became "+9459008800", which Vapi rejects outright. This
  // holds even when a '+' was typed, because a stray '+' in front of a local
  // number is exactly the mistake that produced that bug.
  if (digits.length === 10) return `+${DEFAULT_CC}${digits}`;
  if (DEFAULT_CC === '1' && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  return `+${digits}`;
}

/**
 * Is this something a phone network will actually accept?
 *
 * E.164: a leading '+', a country code that doesn't start with 0, and 8 to 15
 * digits in total. Worth checking explicitly, because the failure mode without
 * it is the worst kind — Freddie promises someone he'll ring them, hangs up,
 * and the call dies silently on a malformed number.
 */
export function isDialable(phone) {
  return /^\+[1-9]\d{7,14}$/.test(String(phone || ''));
}

export function loadConfig() {
  const missing = REQUIRED.filter(([key]) => !process.env[key]);
  if (missing.length) {
    const lines = missing.map(([key, hint]) => `  ${key}  —  ${hint}`);
    throw new Error(
      `Freddie can't start. These settings are missing:\n\n${lines.join('\n')}\n\n` +
      `Add them in Railway under your service, Variables tab, then redeploy.\n`
    );
  }

  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

  return {
    owner: {
      whatsapp: normalisePhone(process.env.OWNER_WHATSAPP),
      name: process.env.OWNER_NAME || 'the person I work for',
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      whatsappFrom: normalisePhone(process.env.TWILIO_WHATSAPP_FROM),
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
      ttsModel: process.env.OPENAI_TTS_MODEL || 'tts-1',
      ttsVoice: process.env.OPENAI_TTS_VOICE || 'onyx',
    },
    vapi: {
      apiKey: process.env.VAPI_API_KEY,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || '',
      webhookSecret: process.env.VAPI_WEBHOOK_SECRET || '',

      // Voice and transcription are settable from Railway so they can be
      // changed without touching the code. If Vapi rejects a voice or a
      // transcriber, swap the value here and redeploy — no re-upload needed.
      voiceProvider: process.env.VAPI_VOICE_PROVIDER || '11labs',
      voiceId: process.env.VAPI_VOICE_ID || 'burt',
      voiceModel: process.env.VAPI_VOICE_MODEL || 'eleven_flash_v2_5',

      // How fast Freddie talks. ElevenLabs' own default is 1.0, and
      // eleven_flash_v2_5 is the latency-optimised model — it delivers a line
      // at a clip, which is most noticeable on the opening introduction,
      // where three clauses arrive in one breath before the other person has
      // tuned in. Settable from Railway so it can be tuned by ear across a
      // few calls without a deploy each time.
      //
      // Unset means the property is omitted from the payload entirely, so
      // deploying this on its own changes nothing. ElevenLabs accepts
      // 0.7 to 1.2; anything outside that is clamped rather than sent, since
      // Vapi rejects the whole call for an out-of-range value.
      voiceSpeed: (() => {
        const raw = process.env.VAPI_VOICE_SPEED;
        if (raw === undefined || raw === '') return null;
        const n = Number.parseFloat(raw);
        if (!Number.isFinite(n)) return null;
        return Math.min(1.2, Math.max(0.7, n));
      })(),

      transcriberProvider: process.env.VAPI_TRANSCRIBER_PROVIDER || 'deepgram',
      transcriberModel: process.env.VAPI_TRANSCRIBER_MODEL || 'nova-3',
      // NOTE: the transcriber's language for ENGLISH calls is derived directly
      // from the call's own language in calls/vapi.js. Arabic is configured
      // separately, below.

      // Arabic gets its own transcriber so it can be swapped from Railway
      // without touching English. Deepgram has no setting that serves
      // Jordanian Arabic with English mixed in — `ar-JO` isn't in Vapi's
      // Deepgram language enum, and Deepgram's `multi` doesn't include Arabic
      // at all — so the candidate is a different provider, not a different
      // language code.
      //
      // Each value falls back to the shared setting above, so leaving all
      // three unset reproduces today's Arabic behaviour exactly: deploying
      // this on its own changes nothing.
      arabicTranscriber: {
        provider: (process.env.VAPI_AR_TRANSCRIBER_PROVIDER
                   || process.env.VAPI_TRANSCRIBER_PROVIDER || 'deepgram').toLowerCase(),
        model: process.env.VAPI_AR_TRANSCRIBER_MODEL
               || process.env.VAPI_TRANSCRIBER_MODEL || 'nova-3',
        language: process.env.VAPI_AR_TRANSCRIBER_LANGUAGE || 'ar',
      },

      // The language calls use unless one is named explicitly. English by
      // default — Freddie no longer opens a call bilingually and asking the
      // other party to choose; set this to 'ar' in Railway to default to
      // Arabic instead, or pass language:'ar' on a specific call.
      // 'en'   — English only (default)
      // 'ar'   — Arabic only
      defaultCallLanguage: ['en', 'ar'].includes(process.env.DEFAULT_CALL_LANGUAGE)
        ? process.env.DEFAULT_CALL_LANGUAGE
        : 'en',
    },
    places: {
      apiKey: process.env.GOOGLE_PLACES_API_KEY || '',
    },
    publicUrl,
    behaviour: {
      requireConfirmation: bool(process.env.REQUIRE_CONFIRMATION, true),
      maxCallsPerDay: int(process.env.MAX_CALLS_PER_DAY, 15),
      voiceReplies: bool(process.env.VOICE_REPLIES, true),
    },
    dataDir: process.env.DATA_DIR || './data',
    port: int(process.env.PORT, 3000),
  };
}

export const config = loadConfig();
