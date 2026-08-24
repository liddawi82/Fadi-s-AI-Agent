// Freddie's memory. A single JSON file — no database to set up, no native
// dependencies to compile. At one user and a handful of calls a day this is
// the right amount of machinery.
//
// On Railway, mount a Volume at /data so this survives redeploys. Without a
// volume Freddie still works, he just forgets his contacts each time you
// deploy a change.

import fs from 'node:fs';
import path from 'node:path';
import { config, normalisePhone } from '../config.js';
import { log } from '../util/log.js';

const FILE = path.join(config.dataDir, 'freddie.json');

const EMPTY = {
  contacts: [],      // { name, phone, language, notes }
  calls: [],         // { id, to, name, goal, status, outcome, startedAt, endedAt }
  conversation: [],  // recent WhatsApp turns, trimmed
  preferences: {},   // freeform things he's learned about you
};

let state = null;
let writeTimer = null;

function ensureDir() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    return true;
  } catch (err) {
    log.warn(`Can't write to ${config.dataDir} (${err.code}). Memory will be in-process only.`);
    return false;
  }
}

function load() {
  if (state) return state;
  try {
    ensureDir();
    const raw = fs.readFileSync(FILE, 'utf8');
    state = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    log.ok(`Memory loaded: ${state.contacts.length} contacts, ${state.calls.length} calls`);
  } catch {
    state = structuredClone(EMPTY);
    log.info('Starting with an empty memory.');
  }
  return state;
}

/** Writes are debounced — many small updates collapse into one disk write. */
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      ensureDir();
      fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      log.warn('Could not save memory:', err.message);
    }
  }, 400);
}

// ── contacts ────────────────────────────────────────────────────────────────

export function findContact(query) {
  const s = load();
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  const asPhone = normalisePhone(query);

  return (
    s.contacts.find((c) => c.phone === asPhone) ||
    s.contacts.find((c) => c.name.toLowerCase() === q) ||
    s.contacts.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

export function saveContact({ name, phone, language, notes }) {
  const s = load();
  const cleanPhone = normalisePhone(phone);
  const existing = s.contacts.find((c) => c.phone === cleanPhone);

  if (existing) {
    if (name) existing.name = name;
    if (language) existing.language = language;
    if (notes) existing.notes = notes;
    save();
    return existing;
  }

  const contact = {
    name: name || cleanPhone,
    phone: cleanPhone,
    language: language || 'auto',
    notes: notes || '',
  };
  s.contacts.push(contact);
  save();
  return contact;
}

export function listContacts() {
  return load().contacts;
}

// ── calls ───────────────────────────────────────────────────────────────────

export function recordCall(call) {
  const s = load();
  s.calls.unshift({ startedAt: new Date().toISOString(), ...call });
  s.calls = s.calls.slice(0, 200);
  save();
}

export function updateCall(id, patch) {
  const s = load();
  const call = s.calls.find((c) => c.id === id);
  if (call) {
    Object.assign(call, patch);
    save();
  }
  return call || null;
}

export function getCall(id) {
  return load().calls.find((c) => c.id === id) || null;
}

export function recentCalls(n = 8) {
  return load().calls.slice(0, n);
}

/** Used to enforce the daily ceiling. */
export function callsToday() {
  const today = new Date().toISOString().slice(0, 10);
  return load().calls.filter((c) => (c.startedAt || '').startsWith(today)).length;
}

// ── conversation ────────────────────────────────────────────────────────────

export function appendTurn(role, content) {
  const s = load();
  s.conversation.push({ role, content, at: new Date().toISOString() });
  // Keep the last ~40 turns. Long enough for context, short enough to stay cheap.
  if (s.conversation.length > 40) s.conversation = s.conversation.slice(-40);
  save();
}

export function conversationHistory() {
  return load().conversation.map(({ role, content }) => ({ role, content }));
}

export function clearConversation() {
  const s = load();
  s.conversation = [];
  save();
}

// ── preferences ─────────────────────────────────────────────────────────────

export function rememberPreference(key, value) {
  const s = load();
  s.preferences[key] = value;
  save();
}

export function preferences() {
  return load().preferences;
}
