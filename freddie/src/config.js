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
export function normalisePhone(raw) {
  if (!raw) return '';
  const trimmed = String(raw).replace(/^whatsapp:/i, '').trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits.replace(/^\+*/, '')}`;
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
      transcriberProvider: process.env.VAPI_TRANSCRIBER_PROVIDER || 'deepgram',
      transcriberModel: process.env.VAPI_TRANSCRIBER_MODEL || 'nova-3',
      transcriberLanguage: process.env.VAPI_TRANSCRIBER_LANGUAGE || 'multi',
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
