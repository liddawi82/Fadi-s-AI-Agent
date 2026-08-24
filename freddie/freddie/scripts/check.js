// A self-test you can run from Railway if something isn't working.
// It checks each service in turn and says, in plain words, what's wrong.
//
// Railway: your service -> Settings -> Deploy -> run `npm run check`
// or just open  https://your-freddie-url/health  in a browser.

import twilio from 'twilio';
import OpenAI from 'openai';

const results = [];
const ok = (name, detail = '') => results.push({ name, state: 'ok', detail });
const bad = (name, detail) => results.push({ name, state: 'FAILED', detail });

const need = (key) => {
  if (!process.env[key]) {
    bad(key, 'Not set. Add it in Railway under Variables.');
    return null;
  }
  return process.env[key];
};

console.log('\nChecking Freddie...\n');

// ── settings present ────────────────────────────────────────────────────────
const sid = need('TWILIO_ACCOUNT_SID');
const token = need('TWILIO_AUTH_TOKEN');
const openaiKey = need('OPENAI_API_KEY');
const vapiKey = need('VAPI_API_KEY');
const owner = need('OWNER_WHATSAPP');
const publicUrl = process.env.PUBLIC_URL;

if (owner && !owner.startsWith('+')) {
  bad('OWNER_WHATSAPP', `Should start with a + and country code. Got "${owner}".`);
}
if (!publicUrl) {
  bad('PUBLIC_URL', 'Not set. Freddie can receive messages but cannot place calls or send voice notes.');
} else if (publicUrl.endsWith('/')) {
  bad('PUBLIC_URL', 'Remove the trailing slash.');
} else {
  ok('PUBLIC_URL', publicUrl);
}
if (!process.env.VAPI_PHONE_NUMBER_ID) {
  bad('VAPI_PHONE_NUMBER_ID', 'Not set. Import your Twilio number in Vapi, then paste its ID here.');
}

// ── Twilio reachable ────────────────────────────────────────────────────────
if (sid && token) {
  try {
    const account = await twilio(sid, token).api.v2010.accounts(sid).fetch();
    if (account.status === 'active') ok('Twilio', `account "${account.friendlyName}" is active`);
    else bad('Twilio', `account status is "${account.status}", not active`);
    if (account.type === 'Trial') {
      results.push({
        name: 'Twilio plan',
        state: 'note',
        detail: 'Still a trial: 5 verified numbers only, 30-day expiry, no real WhatsApp sender.',
      });
    }
  } catch (err) {
    bad('Twilio', `Couldn't sign in — check the SID and auth token. (${err.message})`);
  }
}

// ── OpenAI reachable ────────────────────────────────────────────────────────
if (openaiKey) {
  try {
    const client = new OpenAI({ apiKey: openaiKey });
    await client.models.list();
    ok('OpenAI', 'key works');
  } catch (err) {
    bad('OpenAI', `Key rejected. Is billing set up at platform.openai.com? (${err.message})`);
  }
}

// ── Vapi reachable ──────────────────────────────────────────────────────────
if (vapiKey) {
  try {
    const res = await fetch('https://api.vapi.ai/phone-number', {
      headers: { Authorization: `Bearer ${vapiKey}` },
    });
    if (res.ok) {
      const numbers = await res.json();
      ok('Vapi', `key works, ${Array.isArray(numbers) ? numbers.length : 0} phone number(s) available`);
      if (Array.isArray(numbers) && numbers.length) {
        console.log('  Your Vapi phone number IDs:');
        for (const n of numbers) console.log(`    ${n.number || '(no number)'}  ->  ${n.id}`);
        console.log('');
      }
    } else {
      bad('Vapi', `Key rejected (${res.status}). Use the Private key, not the Public key.`);
    }
  } catch (err) {
    bad('Vapi', err.message);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const width = Math.max(...results.map((r) => r.name.length)) + 2;
for (const r of results) {
  const mark = r.state === 'ok' ? '✓' : r.state === 'note' ? '·' : '✗';
  console.log(`${mark} ${r.name.padEnd(width)} ${r.detail}`);
}

const failures = results.filter((r) => r.state === 'FAILED');
console.log(
  failures.length
    ? `\n${failures.length} thing(s) need fixing before Freddie will work.\n`
    : '\nEverything checks out. Message Freddie on WhatsApp.\n'
);
process.exit(failures.length ? 1 : 0);
