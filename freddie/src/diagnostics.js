// Browser-driveable diagnostics.
//
// While Freddie's outbound texts are blocked (Twilio trial only permits canned
// templates), these two pages are how you talk to him and see what he sees.
// Both are gated behind VAPI_WEBHOOK_SECRET so a stranger who finds the URL
// can't run up your phone bill.
//
//   /diagnose?key=SECRET              — check every service, report plainly
//   /test-call?key=SECRET&to=+1617... — place a real call, show what happened

import twilio from 'twilio';
import OpenAI from 'openai';
import { config, normalisePhone } from './config.js';
import { placeCall } from './calls/vapi.js';
import { log } from './util/log.js';

const normaliseDigits = (p) => String(p || '').replace(/\D/g, '');

export function keyIsValid(req) {
  const provided = String(req.query?.key || '');
  const expected = config.vapi.webhookSecret;
  return Boolean(expected) && provided === expected;
}

/** Ask each service whether it's actually working. Nothing is assumed. */
export async function runDiagnostics() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── settings ──────────────────────────────────────────────────────────────
  add('Public URL', Boolean(config.publicUrl), config.publicUrl || 'NOT SET');
  add('Owner number', config.owner.whatsapp.startsWith('+'), config.owner.whatsapp);
  add('Freddie number', Boolean(config.twilio.whatsappFrom), config.twilio.whatsappFrom);
  add('Vapi phone number ID', Boolean(config.vapi.phoneNumberId),
      config.vapi.phoneNumberId ? 'set' : 'NOT SET — Freddie has no line to call out on');
  add('Vapi webhook secret', Boolean(config.vapi.webhookSecret),
      config.vapi.webhookSecret ? 'set' : 'NOT SET');

  // ── OpenAI ────────────────────────────────────────────────────────────────
  try {
    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 5,
    });
    add('OpenAI', true, `${config.openai.model} replied "${(res.choices[0].message.content || '').trim()}"`);
  } catch (err) {
    add('OpenAI', false, err.message);
  }

  // ── Twilio ────────────────────────────────────────────────────────────────
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const account = await client.api.v2010.accounts(config.twilio.accountSid).fetch();
    const trial = account.type === 'Trial';
    add('Twilio account', account.status === 'active',
        `${account.friendlyName} — ${account.type}${trial ? ' (cannot send custom text; only canned templates)' : ''}`);
  } catch (err) {
    add('Twilio account', false, err.message);
  }

  // Can Freddie actually be TOLD to do anything?
  //
  // Importing the number into Vapi silently claims BOTH channels — voice and
  // messaging — so messaging ends up pointed at api.vapi.ai, and every text
  // sent to Freddie is answered by Vapi instead of reaching this app. Nothing
  // errors; the messages simply never arrive. Worth checking explicitly,
  // because from the outside it looks identical to Freddie ignoring you.
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });
    const line = numbers.find(
      (n) => normaliseDigits(n.phoneNumber) === normaliseDigits(config.twilio.whatsappFrom)
    );
    if (!line) {
      add('Inbound texts reach Freddie', false,
          `${config.twilio.whatsappFrom} isn't in this Twilio account.`);
    } else {
      const want = `${config.publicUrl}/sms`;
      const got = line.smsUrl || '(none)';
      add('Inbound texts reach Freddie', got === want,
          got === want
            ? `messaging webhook points at ${want}`
            : `messaging webhook points at ${got} — it must be ${want}, or your texts never arrive`);
    }
  } catch (err) {
    add('Inbound texts reach Freddie', false, err.message);
  }

  // ── Vapi ──────────────────────────────────────────────────────────────────
  try {
    const res = await fetch('https://api.vapi.ai/phone-number', {
      headers: { Authorization: `Bearer ${config.vapi.apiKey}` },
    });
    if (!res.ok) {
      add('Vapi', false, `key rejected (${res.status}) — is this the Private key, not the Public one?`);
    } else {
      const numbers = await res.json();
      const list = Array.isArray(numbers) ? numbers : [];
      const match = list.find((n) => n.id === config.vapi.phoneNumberId);
      add('Vapi key', true, `${list.length} phone number(s) on the account`);
      add('Vapi number ID matches', Boolean(match),
          match
            ? `${match.number || '(no number shown)'} — this is the line Freddie calls from`
            : `VAPI_PHONE_NUMBER_ID doesn't match any number on the account. Available: ${
                list.map((n) => `${n.number || '?'} = ${n.id}`).join(', ') || 'none'
              }`);
    }
  } catch (err) {
    add('Vapi', false, err.message);
  }

  // ── Google Places ─────────────────────────────────────────────────────────
  // Powers find_place (booking a specific named business) and find_restaurants
  // / suggest_restaurants (recommendations). Without a working key both fail
  // gracefully — Freddie says he can't look it up rather than crashing — but
  // that's silent from the outside, so it's worth checking here explicitly.
  if (!config.places.apiKey) {
    add('Google Places', false, 'GOOGLE_PLACES_API_KEY is NOT SET — restaurant lookups and find_place will not work.');
  } else {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.places.apiKey,
          'X-Goog-FieldMask': 'places.displayName',
        },
        body: JSON.stringify({ textQuery: 'restaurants near Amman, Jordan', maxResultCount: 1 }),
      });
      if (res.ok) {
        const data = await res.json();
        const found = (data.places || [])[0]?.displayName?.text;
        add('Google Places', true, found ? `key works — e.g. found "${found}"` : 'key works, but returned no results for the test query');
      } else {
        const detail = await res.text();
        const hint =
          res.status === 403
            ? 'likely the "Places API (New)" isn\'t enabled on this key, or it\'s restricted to the wrong APIs/referrers'
            : res.status === 400
            ? 'likely a malformed or invalid key'
            : `unexpected status`;
        add('Google Places', false, `key rejected (${res.status}) — ${hint}. ${detail.slice(0, 200)}`);
      }
    } catch (err) {
      add('Google Places', false, err.message);
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    canPlaceCalls: Boolean(config.vapi.phoneNumberId && config.publicUrl),
  };
}

/**
 * Place a real call, and report exactly what happened either way.
 *
 * The default is a genuine conversation with the owner, not a canned test — an
 * earlier version told Freddie to "keep it under a minute and end the call",
 * which he dutifully obeyed, hanging up while you were still talking to him.
 */
export async function runTestCall(rawTo, goalOverride, lang) {
  const to = normalisePhone(rawTo || config.owner.whatsapp);
  const language = ['ar', 'en'].includes(lang) ? lang : config.vapi.defaultCallLanguage;

  const goal =
    goalOverride ||
    `You are calling ${config.owner.name} himself — your owner, not a stranger.
He wants to talk to you directly: to hear how you sound, to try you in Arabic
and English, and possibly to give you instructions.

Have a real conversation. Answer whatever he asks. If he gives you a task,
acknowledge it clearly and tell him you'll handle it after the call.

Do NOT rush. Do NOT end the call yourself unless he says goodbye or asks you to
hang up. If he goes quiet, wait — he may be thinking. This call has no time
limit and no agenda beyond talking with him.`;

  log.info(`Test call requested to ${to} (language: ${language})`);

  try {
    const call = await placeCall({ to, goal, language, calleeName: config.owner.name });
    return {
      ok: true,
      callId: call.id,
      to,
      language,
      message: `Calling ${to} now — your phone should ring within a few seconds. Talk to him properly; he won't hang up on you.`,
    };
  } catch (err) {
    return { ok: false, to, language, error: err.message };
  }
}

/** Render a result as a readable page rather than raw JSON. */
export function renderPage(title, result) {
  const rows = (result.checks || [])
    .map(
      (c) => `<tr><td>${c.ok ? '&#10003;' : '&#10007;'}</td><td>${esc(c.name)}</td><td>${esc(c.detail)}</td></tr>`
    )
    .join('');

  const body = rows
    ? `<table>${rows}</table>`
    : `<pre>${esc(JSON.stringify(result, null, 2))}</pre>`;

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freddie — ${esc(title)}</title>
<style>
 body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;
      background:#0e151d;color:#dee6ed}
 h1{font-size:1.6rem;margin:0 0 6px}
 .sub{color:#7b8b99;margin-bottom:24px}
 table{border-collapse:collapse;width:100%}
 td{padding:9px 10px;border-bottom:1px solid #26333f;vertical-align:top}
 td:first-child{width:24px;font-weight:700}
 tr:has(td:first-child:not(:empty)) td:first-child{color:#6bc4ab}
 pre{background:#17212b;padding:16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
 .bad{color:#e0836a}
</style>
<h1>Freddie — ${esc(title)}</h1>
<div class="sub">${result.ok ? 'Everything checks out.' : 'Something needs attention.'}</div>
${body}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
