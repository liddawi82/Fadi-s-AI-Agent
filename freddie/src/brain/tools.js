// The things Freddie can actually do. Each tool is a description the model
// reads, plus a function that runs when it decides to use one.

import { config, normalisePhone } from '../config.js';
import { placeCall, getCallStatus, isBlockedNumber } from '../calls/vapi.js';
import * as memory from '../memory/store.js';
import { log } from '../util/log.js';

// ── the definitions the model sees ──────────────────────────────────────────

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'place_call',
      description:
        'Call a phone number and pursue a specific goal — a reservation, an invitation, a question. ' +
        'Only use this once you know the number and what success looks like.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Phone number in full international form, e.g. +12025551234' },
          goal: {
            type: 'string',
            description:
              'What the call must achieve, written for Freddie to read on the phone. Be specific: ' +
              'party size, date, time, name to book under, acceptable alternatives.',
          },
          language: {
            type: 'string',
            enum: ['en', 'ar', 'auto'],
            description: "Language to open in. 'ar' for Jordanian Arabic, 'en' for American English.",
          },
          callee_name: { type: 'string', description: 'Who or what is being called, for the log.' },
          constraints: {
            type: 'string',
            description: 'Anything Freddie must not agree to. Optional but useful.',
          },
        },
        required: ['to', 'goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_call',
      description: 'Check what happened on a call that has already been placed.',
      parameters: {
        type: 'object',
        properties: { call_id: { type: 'string' } },
        required: ['call_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_place',
      description:
        'Look up a business and its phone number by name and area, e.g. "Fakhreldin, Amman" or ' +
        '"Lebanese restaurant near Dupont Circle, Washington DC".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for, including the area.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_contact',
      description: 'Remember a person or place, so it can be called by name next time.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          language: { type: 'string', enum: ['en', 'ar', 'auto'], description: 'Language this person prefers.' },
          notes: { type: 'string', description: 'Anything worth remembering — usual table, relationship, etc.' },
        },
        required: ['name', 'phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_contact',
      description: 'Find a saved contact by name, to get their number before calling.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        "Store a lasting preference — 'prefers late tables', 'allergic to shellfish', " +
        "'always books under the name Fadi L.'. Not for one-off facts.",
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
  },
];

// ── the implementations ─────────────────────────────────────────────────────

async function findPlace(query) {
  if (!config.places.apiKey) {
    return {
      ok: false,
      message:
        "I can't look up numbers — no Google Places key is configured. Ask him for the number directly.",
    };
  }

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.places.apiKey,
        'X-Goog-FieldMask':
          'places.displayName,places.internationalPhoneNumber,places.formattedAddress,places.businessStatus',
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 3 }),
    });

    if (!res.ok) {
      const detail = await res.text();
      log.warn('Places lookup failed:', res.status, detail.slice(0, 200));
      return { ok: false, message: `The lookup failed (${res.status}).` };
    }

    const data = await res.json();
    const places = (data.places || []).map((p) => ({
      name: p.displayName?.text || 'unknown',
      phone: p.internationalPhoneNumber || null,
      address: p.formattedAddress || '',
      status: p.businessStatus || '',
    }));

    if (!places.length) return { ok: false, message: 'Nothing found for that.' };

    const withPhone = places.filter((p) => p.phone);
    if (!withPhone.length) {
      return {
        ok: false,
        message: `Found ${places[0].name} but Google has no phone number for it. Many places in Jordan take bookings over WhatsApp or Instagram instead.`,
        places,
      };
    }
    return { ok: true, places: withPhone };
  } catch (err) {
    return { ok: false, message: `The lookup failed: ${err.message}` };
  }
}

async function doPlaceCall(args) {
  const to = normalisePhone(args.to);

  if (isBlockedNumber(to)) {
    return { ok: false, message: 'That is an emergency or crisis line. I will not call it.' };
  }

  const used = memory.callsToday();
  if (used >= config.behaviour.maxCallsPerDay) {
    return {
      ok: false,
      message: `Daily call limit reached (${config.behaviour.maxCallsPerDay}). Tell him, and don't try again today unless he raises the limit.`,
    };
  }

  try {
    const call = await placeCall({
      to,
      goal: args.goal,
      language: args.language || 'auto',
      calleeName: args.callee_name || '',
      constraints: args.constraints || '',
    });

    memory.recordCall({
      id: call.id,
      to,
      name: args.callee_name || '',
      goal: args.goal,
      status: 'dialling',
    });

    return {
      ok: true,
      call_id: call.id,
      message: `Dialling ${args.callee_name || to} now. The result will arrive when the call ends — don't wait for it, just tell him it's ringing.`,
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function doCheckCall(callId) {
  const local = memory.getCall(callId);
  const remote = await getCallStatus(callId);
  if (!remote && !local) return { ok: false, message: 'No call with that id.' };
  return {
    ok: true,
    status: remote?.status || local?.status || 'unknown',
    ended_reason: remote?.endedReason || null,
    outcome: local?.outcome || null,
    summary: remote?.analysis?.summary || null,
  };
}

/** Runs a tool call from the model and returns a JSON-serialisable result. */
export async function runTool(name, args) {
  log.info(`tool: ${name}`, args);

  switch (name) {
    case 'place_call':
      return doPlaceCall(args);

    case 'check_call':
      return doCheckCall(args.call_id);

    case 'find_place':
      return findPlace(args.query);

    case 'save_contact': {
      const saved = memory.saveContact(args);
      return { ok: true, contact: saved };
    }

    case 'lookup_contact': {
      const found = memory.findContact(args.name);
      return found
        ? { ok: true, contact: found }
        : { ok: false, message: `No saved contact matching "${args.name}".` };
    }

    case 'remember':
      memory.rememberPreference(args.key, args.value);
      return { ok: true };

    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}
