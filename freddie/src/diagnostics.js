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

  return {
    ok: checks.every((c) => c.ok),
    checks,
    canPlaceCalls: Boolean(config.vapi.phoneNumberId && config.publicUrl),
  };
}

/** Place a real call, and report exactly what happened either way. */
export async function runTestCall(rawTo, goalOverride) {
  const to = normalisePhone(rawTo || config.owner.whatsapp);

  const goal =
    goalOverride ||
    `This is a test call. Greet them warmly, say you're Freddie, ${config.owner.name}'s assistant, ` +
    `and that this is a test to check you sound alright. Ask them how the line sounds and whether ` +
    `they can understand you clearly. If they answer in Arabic, switch to Jordanian Arabic and keep ` +
    `going. Keep it under a minute, thank them, and end the call.`;

  log.info(`Test call requested to ${to}`);

  try {
    const call = await placeCall({ to, goal, language: 'auto', calleeName: 'test call' });
    return {
      ok: true,
      callId: call.id,
      to,
      message: `Calling ${to} now — your phone should ring within a few seconds.`,
    };
  } catch (err) {
    return { ok: false, to, error: err.message };
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
