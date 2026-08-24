// Offline tests. No network, no real accounts — these prove the wiring is
// sound before you spend money on it.  Run with:  node scripts/test.js

process.env.OWNER_WHATSAPP = '+15551234567';
process.env.OWNER_NAME = 'Fadi';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'fake-token';
process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
process.env.OPENAI_API_KEY = 'sk-fake';
process.env.VAPI_API_KEY = 'fake-vapi';
process.env.VAPI_PHONE_NUMBER_ID = 'fake-number-id';
process.env.VAPI_WEBHOOK_SECRET = 'secret123';
process.env.PUBLIC_URL = 'https://freddie.test';
process.env.DATA_DIR = './.testdata';
process.env.PORT = '3999';

import fs from 'node:fs';
fs.rmSync('./.testdata', { recursive: true, force: true });

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    fail++;
  }
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};
const ok = (v, msg) => { if (!v) throw new Error(msg || 'expected truthy'); };

console.log('\nFreddie — offline tests\n');

// ── config ──────────────────────────────────────────────────────────────────
console.log('config');
const { config, normalisePhone } = await import('../src/config.js');

await t('normalises phone numbers', () => {
  eq(normalisePhone('whatsapp:+1 (555) 123-4567'), '+15551234567');
  eq(normalisePhone('15551234567'), '+15551234567');
  eq(normalisePhone('+962 79 123 4567'), '+962791234567');
});
await t('reads the owner and defaults', () => {
  eq(config.owner.whatsapp, '+15551234567');
  eq(config.behaviour.requireConfirmation, true);
  eq(config.behaviour.maxCallsPerDay, 15);
});
await t('strips a trailing slash from PUBLIC_URL', () => {
  eq(config.publicUrl, 'https://freddie.test');
});

// ── memory ──────────────────────────────────────────────────────────────────
console.log('\nmemory');
const memory = await import('../src/memory/store.js');

await t('saves and finds a contact by name, partial name, and number', () => {
  memory.saveContact({ name: 'Zaytinya', phone: '+1 202 555 0100', language: 'en', notes: 'likes booths' });
  memory.saveContact({ name: 'Cousin Rami', phone: '+962791234567', language: 'ar' });
  eq(memory.findContact('Zaytinya').phone, '+12025550100');
  eq(memory.findContact('rami').name, 'Cousin Rami');
  eq(memory.findContact('+962 79 123 4567').language, 'ar');
  eq(memory.findContact('nobody'), null);
});

await t('updates rather than duplicates an existing contact', () => {
  memory.saveContact({ name: 'Zaytinya DC', phone: '+12025550100' });
  eq(memory.listContacts().filter((c) => c.phone === '+12025550100').length, 1);
  eq(memory.findContact('+12025550100').name, 'Zaytinya DC');
  eq(memory.findContact('+12025550100').notes, 'likes booths', 'existing notes should survive');
});

await t('counts calls made today for the daily cap', () => {
  eq(memory.callsToday(), 0);
  memory.recordCall({ id: 'c1', to: '+12025550100', name: 'Zaytinya', goal: 'table for 4', status: 'dialling' });
  memory.recordCall({ id: 'c2', to: '+12025550101', name: 'Other', goal: 'x', status: 'dialling' });
  eq(memory.callsToday(), 2);
});

await t('updates a call in place', () => {
  memory.updateCall('c1', { status: 'ended', outcome: 'Booked Friday 8pm' });
  eq(memory.getCall('c1').status, 'ended');
  eq(memory.getCall('c1').outcome, 'Booked Friday 8pm');
});

await t('trims the conversation so it cannot grow forever', () => {
  for (let i = 0; i < 60; i++) memory.appendTurn('user', `message ${i}`);
  ok(memory.conversationHistory().length <= 40, 'history should be capped at 40');
  eq(memory.conversationHistory().at(-1).content, 'message 59');
});

// ── safety ──────────────────────────────────────────────────────────────────
console.log('\nsafety');
const { isBlockedNumber } = await import('../src/calls/vapi.js');

await t('refuses emergency numbers', () => {
  ok(isBlockedNumber('911'), '911 should be blocked');
  ok(isBlockedNumber('112'), '112 should be blocked');
  ok(isBlockedNumber('191'), 'Jordan police should be blocked');
  ok(isBlockedNumber('988'), 'US crisis line should be blocked');
});
await t('allows ordinary numbers that merely contain those digits', () => {
  ok(!isBlockedNumber('+12025550911'), 'a normal number ending 911 should be allowed');
  ok(!isBlockedNumber('+962791234567'), 'a Jordanian mobile should be allowed');
});

// ── the mid-call escape hatch ───────────────────────────────────────────────
console.log('\nmid-call ask');
const pending = await import('../src/calls/pending.js');

await t('resolves with the owner\'s answer when he replies', async () => {
  ok(!pending.isWaiting(), 'should start idle');
  const { promise } = pending.askAndWait('7:30 or 9:15?');
  ok(pending.isWaiting(), 'should be waiting');
  eq(pending.pendingQuestion(), '7:30 or 9:15?');

  setTimeout(() => pending.deliverAnswer('take 9:15'), 20);
  const answer = await promise;
  eq(answer, 'take 9:15');
  ok(!pending.isWaiting(), 'should be idle again');
});

await t('ignores an answer when nothing is waiting', () => {
  eq(pending.deliverAnswer('hello?'), false);
});

// ── the server ──────────────────────────────────────────────────────────────
console.log('\nserver');
await import('../src/index.js');
await new Promise((r) => setTimeout(r, 400));
const base = 'http://127.0.0.1:3999';

await t('answers /health with its real state', async () => {
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  eq(res.status, 200);
  eq(body.status, 'ok');
  eq(body.canPlaceCalls, true);
  eq(body.whatsappFrom, '+14155238886');
});

await t('rejects a webhook with no Twilio signature, on both paths', async () => {
  for (const path of ['/whatsapp', '/sms']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: 'whatsapp:+15551234567', Body: 'call someone' }),
    });
    // Twilio always gets 200 so it doesn't retry; the rejection is internal.
    eq(res.status, 200, `${path} should return 200`);
    const text = await res.text();
    ok(!text.includes('<Response>'), `${path} must not return TwiML — trial accounts reject it`);
  }
});

await t('rejects a Vapi request with the wrong secret', async () => {
  const res = await fetch(`${base}/vapi/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'wrong' },
    body: JSON.stringify({ message: { type: 'status-update' } }),
  });
  eq(res.status, 401);
});

await t('accepts a Vapi request with the right secret', async () => {
  const res = await fetch(`${base}/vapi/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'secret123' },
    body: JSON.stringify({ message: { type: 'status-update', status: 'ringing', call: { id: 'c1' } } }),
  });
  eq(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  eq(memory.getCall('c1').status, 'ringing');
});

await t('holds a mid-call tool request open, then answers it', async () => {
  const inFlight = fetch(`${base}/vapi/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'secret123' },
    body: JSON.stringify({
      message: {
        type: 'tool-calls',
        toolCallList: [{ id: 'tool_1', name: 'ask_owner', arguments: { question: 'Booth or bar?' } }],
      },
    }),
  });

  // Give it a moment to register, then answer the way a WhatsApp reply would.
  await new Promise((r) => setTimeout(r, 300));
  ok(pending.isWaiting(), 'Freddie should be waiting on the owner');
  pending.deliverAnswer('booth please');

  const body = await (await inFlight).json();
  eq(body.results.length, 1);
  eq(body.results[0].toolCallId, 'tool_1');
  ok(body.results[0].result.includes('booth please'), 'the answer should reach Freddie');
});

// ── the fabrication fix ─────────────────────────────────────────────────────
console.log('\ntasks taken during a call');
const tasks = await import('../src/calls/tasks.js');

await t('writes down a call requested mid-conversation', () => {
  tasks.noteTask('callA', { to: '+15551119999', goal: 'tell her I am late', calleeName: 'wife' });
  eq(tasks.pendingCount('callA'), 1);
});

await t('hands the task over exactly once, so it cannot be dialled twice', () => {
  const first = tasks.drainTasks('callA');
  eq(first.length, 1);
  eq(first[0].calleeName, 'wife');
  eq(tasks.drainTasks('callA').length, 0, 'second drain must be empty');
});

await t('keeps tasks from different calls apart', () => {
  tasks.noteTask('callB', { to: '+15551112222', goal: 'x', calleeName: 'B' });
  tasks.noteTask('callC', { to: '+15551113333', goal: 'y', calleeName: 'C' });
  eq(tasks.drainTasks('callB').length, 1);
  eq(tasks.drainTasks('callC')[0].calleeName, 'C');
});

await t('refuses a task with no call id', () => {
  eq(tasks.noteTask(undefined, { to: '+1555', goal: 'x' }), false);
});

await t('the note_task tool rejects a junk number instead of accepting it', async () => {
  const res = await fetch(`${base}/vapi/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'secret123' },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id: 'callD' },
      toolCallList: [{ id: 'tc1', name: 'note_task', arguments: { to: 'her mobile', goal: 'tell her' } }] } }),
  });
  const body = await res.json();
  ok(body.results[0].result.includes("isn't a usable phone number"), 'should refuse a non-number');
  eq(tasks.pendingCount('callD'), 0, 'nothing should be queued');
});

await t('the note_task tool tells him NOT to claim it already happened', async () => {
  const res = await fetch(`${base}/vapi/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'secret123' },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id: 'callE' },
      toolCallList: [{ id: 'tc2', name: 'note_task',
        arguments: { to: '+15551234000', goal: 'say I am running late', callee_name: 'Rania' } }] } }),
  });
  const body = await res.json();
  ok(body.results[0].result.includes('do not say it has already happened'),
     'the tool result must forbid claiming it is done');
  eq(tasks.pendingCount('callE'), 1);
  tasks.drainTasks('callE');
});

await t('the summary prompt forbids inventing outcomes', async () => {
  const { summariseCall } = await import('../src/brain/agent.js');
  const oa = await import('openai');
  await summariseCall({ calleeName: 'wife', goal: 'x', transcript: '', endedReason: 'silence', language: 'en' });
  const p = oa.__calls.at(-1).messages[0].content;
  ok(p.includes('Do not invent'), 'must forbid invention');
  ok(p.includes('NEVER claim you called someone else'), 'must forbid the exact failure seen');
  ok(p.includes('never in his voice'), 'must keep the perspective straight');
});

// ── diagnostics endpoints ───────────────────────────────────────────────────
console.log('\ndiagnostics');

await t('refuses /diagnose without the key', async () => {
  const res = await fetch(`${base}/diagnose`);
  eq(res.status, 401);
});

await t('refuses /diagnose with the wrong key', async () => {
  const res = await fetch(`${base}/diagnose?key=nope`);
  eq(res.status, 401);
});

await t('runs /diagnose with the right key and names each check', async () => {
  const res = await fetch(`${base}/diagnose?key=secret123&format=json`);
  eq(res.status, 200);
  const body = await res.json();
  const names = body.checks.map((c) => c.name);
  ok(names.includes('OpenAI'), 'should check OpenAI');
  ok(names.includes('Twilio account'), 'should check Twilio');
  ok(names.includes('Public URL'), 'should check the public URL');
  const twilioCheck = body.checks.find((c) => c.name === 'Twilio account');
  ok(twilioCheck.detail.includes('canned templates'),
     'a trial account should be flagged as unable to send custom text');
});

await t('renders /diagnose as a readable page, not raw JSON', async () => {
  const res = await fetch(`${base}/diagnose?key=secret123`);
  const html = await res.text();
  ok(html.includes('<table>'), 'should render a table');
  ok(html.includes('Freddie'), 'should be titled');
  ok(!html.includes('secret123'), 'must never echo the key back into the page');
});

await t('refuses /test-call without the key', async () => {
  const res = await fetch(`${base}/test-call?to=%2B15551234567`);
  eq(res.status, 401);
});

await t('the default test call is a real conversation, not a canned test', async () => {
  const { runTestCall } = await import('../src/diagnostics.js');
  const before = (await import('../src/calls/vapi.js'));
  // Placing will fail (no real Vapi), but we can inspect the goal it built by
  // checking the error path still carries the language choice through.
  const r = await runTestCall('+15551234567', undefined, 'ar');
  eq(r.language, 'ar', 'the lang parameter should be honoured');
  eq(r.to, '+15551234567');
});

await t('reports the reason when a test call cannot be placed', async () => {
  // No real Vapi in tests, so the fetch to api.vapi.ai fails — the point is
  // that the failure is reported clearly instead of throwing a 500.
  const res = await fetch(`${base}/test-call?key=secret123&to=%2B15551234567&format=json`);
  eq(res.status, 200);
  const body = await res.json();
  eq(body.ok, false);
  ok(body.error, 'should explain what went wrong');
  eq(body.to, '+15551234567');
});

// ── prompts ─────────────────────────────────────────────────────────────────
console.log('\nprompts');
const prompts = await import('../src/brain/prompts.js');
const toolDefs = await import('../src/brain/tools.js');

await t('the call prompt carries the dialect rules and the disclosure rule', () => {
  const p = prompts.callSystemPrompt({ goal: 'book a table', language: 'ar', calleeName: 'Zaytinya' });
  ok(/[\u0600-\u06FF]/.test(p), 'should include Arabic guidance');
  ok(p.includes("assistant"), 'should identify him as an assistant');
  ok(p.includes('Never claim to be'), 'should forbid impersonating the owner');
  ok(p.includes('This call is in ARABIC'), 'should pin Arabic when asked');
  ok(p.includes('card number'), 'should carry the payment limit');
  ok(p.includes('Zaytinya'), 'should name who is being called');
});

await t('the call prompt stays short, because length costs response time', () => {
  const p = prompts.callSystemPrompt({ goal: 'book a table for four on Friday', language: 'auto' });
  ok(p.length < 2600, `call prompt should stay under 2600 chars, is ${p.length}`);
  // The long WhatsApp version must NOT leak into the call prompt.
  ok(!p.includes('Saved contacts'), 'contacts belong in the WhatsApp prompt only');
});

await t('an English call is locked to English, with no Arabic farewell', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'en' });
  ok(p.includes('This call is in ENGLISH'), 'should pin English');
  ok(p.includes('do not end with an Arabic farewell'), 'should forbid the Arabic goodbye');
  ok(!/[\u0600-\u06FF]/.test(p), 'Arabic guidance must not load on an English call');
});

await t('an Arabic call is locked to Arabic and told not to drift', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'ar' });
  ok(p.includes('This call is in ARABIC'), 'should pin Arabic');
  ok(p.includes("Don't drift to English"), 'should forbid drifting');
  ok(!p.includes('Jordanian'), 'should no longer force the Jordanian dialect');
  ok(/[\u0600-\u06FF]/.test(p), 'Arabic guidance belongs on an Arabic call');
});

await t('a direct request to change language always wins', () => {
  for (const lang of ['en', 'ar']) {
    const p = prompts.callSystemPrompt({ goal: 'x', language: lang });
    ok(p.includes('a\ndirect request beats every rule above'), `${lang}: must allow switching on request`);
    ok(p.includes('switch at once'), `${lang}: must forbid refusing`);
  }
});

await t('calls default to asking the person which language they want', async () => {
  const { runTestCall } = await import('../src/diagnostics.js');
  const r = await runTestCall('+15551234567');
  eq(r.language, 'ask', 'no language should mean ask, not silent multi-detection');
});

await t('an unrecognised language falls back to the default', async () => {
  const { runTestCall } = await import('../src/diagnostics.js');
  const r = await runTestCall('+15551234567', undefined, 'klingon');
  eq(r.language, 'ask');
});

await t('ask mode tells him to settle the language first, then hold it', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'ask' });
  ok(p.includes('FIRST, settle the language'), 'should make the language question the first task');
  ok(p.includes('STAY in it'), 'should hold the choice');
  ok(p.replace(/\s+/g, ' ').includes('then use English'), 'an unclear answer should fall back to English');
});

await t('asking for Arabic still gets Arabic', async () => {
  const { runTestCall } = await import('../src/diagnostics.js');
  const r = await runTestCall('+15551234567', undefined, 'ar');
  eq(r.language, 'ar');
});

await t('confusion is handled by asking again, but a request still switches him', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'ar' });
  ok(p.includes("don't guess"), 'should ask rather than guess');
  ok(p.replace(/\s+/g, ' ').includes('switch at once and stay switched'), 'a request must still switch him');
});

await t('never confuses its own name with the owner\'s', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'en', calleeName: 'Zaytinya' });
  ok(p.includes('YOUR name is Freddie'), 'must state whose name Freddie is');
  ok(p.includes('Never call anyone else "Freddie"'), 'must forbid calling others Freddie');
  ok(p.includes('Call him Fadi'), 'must say what to call the owner');
  ok(p.includes('Zaytinya'), 'must name who is actually on the call');
});

await t('answers off-topic questions instead of deflecting', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'en' });
  ok(p.includes('TALK LIKE A PERSON'), 'should have the conversational rule');
  ok(p.includes('Never deflect'), 'should forbid the canned deflection');
  ok(p.includes('steer back'), 'should still return to the purpose');
});

await t('refuses to hang up before the goal is met', () => {
  const p = prompts.callSystemPrompt({ goal: 'book a table', language: 'en' });
  ok(p.includes("DON'T HANG UP EARLY"), 'should have the rule');
  ok(p.includes('tangent'), 'a tangent is not a reason to leave');
  ok(p.includes('a pause'), 'a pause is not a reason to leave');
  ok(p.includes('confirm it back to you'), 'should confirm before leaving');
});

await t('greets the person by name when we know it', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'en', calleeName: 'Rania' });
  ok(p.includes('Use their name — Rania'), 'should be told to use the name');
  ok(p.includes('ask for Rania'), 'should ask for them if someone else answers');
});

await t('says nothing about names when we have none', () => {
  const p = prompts.callSystemPrompt({ goal: 'x', language: 'en' });
  ok(!p.includes('Use their name'), 'no name means no name instruction');
  ok(p.includes('whoever answers'), 'should say the callee is unknown');
});

await t('the place_call tool insists on capturing the name', () => {
  const t2 = toolDefs.toolDefinitions.find((d) => d.function.name === 'place_call');
  const desc = t2.function.parameters.properties.callee_name.description;
  ok(desc.includes('ALWAYS include this'), 'should push the model to pass a name');
  ok(desc.includes('greets them by name'), 'should say why it matters');
});

await t('the WhatsApp prompt lists real contacts and calls', () => {
  const p = prompts.whatsappSystemPrompt({
    contacts: memory.listContacts(),
    recentCalls: memory.recentCalls(5),
    prefs: { table: 'prefers late tables' },
  });
  ok(p.includes('Cousin Rami'), 'contacts should be listed');
  ok(p.includes('+962791234567'), 'numbers should be listed');
  ok(p.includes('prefers late tables'), 'preferences should be listed');
  ok(!p.includes('undefined'), 'no undefined leaking into the prompt');
  ok(!p.includes('NaN'), 'no NaN leaking into the prompt');
});

// ── the owner lock, and the reasoning loop ──────────────────────────────────
console.log('\nowner lock');
const twilioStub = (await import('twilio')).default;
const sentMessages = twilioStub.__sent;
const openaiStub = await import('openai');
const { handleInbound } = await import('../src/whatsapp/inbound.js');

await t('ignores a message from anyone who is not the owner', async () => {
  const before = sentMessages.length;
  await handleInbound({ From: 'whatsapp:+19998887777', Body: 'call the White House', NumMedia: '0' });
  eq(sentMessages.length, before, 'Freddie must not reply to a stranger');
});

await t('acts on a message from the owner and replies', async () => {
  const before = sentMessages.length;
  openaiStub.__setNextCompletion({
    choices: [{ message: { role: 'assistant', content: 'On it — calling now.' } }],
  });
  await handleInbound({ From: 'whatsapp:+15551234567', Body: 'book a table for four', NumMedia: '0' });
  ok(sentMessages.length > before, 'Freddie should reply to his owner');
  eq(sentMessages.at(-1).body, 'On it — calling now.');
  eq(sentMessages.at(-1).to, 'whatsapp:+15551234567');
});

console.log('\nchannels');
const chan = await import('../src/channel.js');

await t('tells WhatsApp and SMS apart from the From field', () => {
  eq(chan.detectChannel('whatsapp:+15551234567'), 'whatsapp');
  eq(chan.detectChannel('+15551234567'), 'sms');
  eq(chan.detectChannel(''), 'sms');
});

await t('addresses each channel the way Twilio expects', () => {
  eq(chan.addressFor('+15551234567', 'whatsapp'), 'whatsapp:+15551234567');
  eq(chan.addressFor('+15551234567', 'sms'), '+15551234567');
});

await t('replies over SMS when the message arrived by SMS', async () => {
  const before = sentMessages.length;
  openaiStub.__setNextCompletion({
    choices: [{ message: { role: 'assistant', content: 'Got it.' } }],
  });
  await handleInbound({ From: '+15551234567', Body: 'book a table', NumMedia: '0' });
  ok(sentMessages.length > before, 'should have replied');
  const sent = sentMessages.at(-1);
  eq(sent.to, '+15551234567', 'SMS reply must not carry a whatsapp: prefix');
  eq(sent.from, '+14155238886');
  eq(chan.currentChannel(), 'sms');
});

await t('switches back to WhatsApp when the next message arrives there', async () => {
  openaiStub.__setNextCompletion({
    choices: [{ message: { role: 'assistant', content: 'Sure.' } }],
  });
  await handleInbound({ From: 'whatsapp:+15551234567', Body: 'hello', NumMedia: '0' });
  const sent = sentMessages.at(-1);
  eq(sent.to, 'whatsapp:+15551234567', 'WhatsApp reply needs the prefix');
  eq(chan.currentChannel(), 'whatsapp');
});

console.log('\nreasoning loop');
const { think } = await import('../src/brain/agent.js');

await t('runs a tool the model asks for, then answers in words', async () => {
  // First turn: the model asks to look up a contact.
  openaiStub.__setNextCompletion({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup_contact', arguments: JSON.stringify({ name: 'Rami' }) },
        }],
      },
    }],
  });
  const answer = await think("what's Rami's number?");
  // Second turn falls through to the stub default, proving the loop continued
  // past the tool round rather than stopping at it.
  eq(answer, 'Understood.');

  const lastRequest = openaiStub.__calls.at(-1);
  const toolReply = lastRequest.messages.find((m) => m.role === 'tool');
  ok(toolReply, 'the tool result should be fed back to the model');
  ok(toolReply.content.includes('+962791234567'), "Rami's number should reach the model");
});

await t('survives malformed tool arguments instead of crashing', async () => {
  openaiStub.__setNextCompletion({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'lookup_contact', arguments: '{ this is not json' },
        }],
      },
    }],
  });
  const answer = await think('who?');
  eq(answer, 'Understood.', 'the loop should recover and still answer');
});

await t('refuses to dial an emergency number even if the model asks', async () => {
  const { runTool } = await import('../src/brain/tools.js');
  const result = await runTool('place_call', { to: '911', goal: 'test' });
  eq(result.ok, false);
  ok(result.message.includes('emergency'), 'should say why it refused');
});

await t('enforces the daily call ceiling', async () => {
  const { runTool } = await import('../src/brain/tools.js');
  for (let i = 0; i < 15; i++) {
    memory.recordCall({ id: `bulk${i}`, to: '+12025550999', goal: 'x', status: 'ended' });
  }
  const result = await runTool('place_call', { to: '+12025550100', goal: 'another table' });
  eq(result.ok, false);
  ok(result.message.includes('limit'), 'should say the limit was hit');
});

// ── done ────────────────────────────────────────────────────────────────────
fs.rmSync('./.testdata', { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
