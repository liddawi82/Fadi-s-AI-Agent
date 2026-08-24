// The mid-call escape hatch.
//
// When Freddie is on the phone and hits a question only you can answer —
// "they only have 7:30 or 9:15" — he calls the ask_owner tool. That tool has
// to WAIT for your WhatsApp reply while the call is still live, then hand your
// answer back to him so he can carry on talking.
//
// Vapi gives a tool roughly 20–30 seconds before it gives up, so this waits
// a little under that and then tells Freddie to use his own judgement rather
// than leaving the host in silence.

import { log } from '../util/log.js';

const WAIT_MS = 22_000;

/** questionId -> { resolve, timer, question, askedAt } */
const waiting = new Map();

let counter = 0;
const nextId = () => `q${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Register a question and return a promise that resolves with the owner's
 * answer, or with null if he doesn't reply in time.
 */
export function askAndWait(question) {
  const id = nextId();

  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      log.warn(`No answer to "${question}" within ${WAIT_MS / 1000}s — Freddie will improvise.`);
      resolve(null);
    }, WAIT_MS);

    waiting.set(id, { resolve, timer, question, askedAt: Date.now() });
  });

  return { id, promise };
}

/**
 * Called when a WhatsApp message arrives. If Freddie is mid-call waiting on an
 * answer, this consumes the message and returns true — the message was the
 * answer, not a new instruction.
 */
export function deliverAnswer(text) {
  if (waiting.size === 0) return false;

  // Answer the oldest outstanding question. In practice there is only ever one,
  // because Freddie holds the line while he waits.
  const [id, entry] = [...waiting.entries()].sort((a, b) => a[1].askedAt - b[1].askedAt)[0];
  clearTimeout(entry.timer);
  waiting.delete(id);
  log.ok(`Answer delivered to a waiting call: "${text.slice(0, 60)}"`);
  entry.resolve(text);
  return true;
}

/** True when Freddie is on a call waiting to hear back from you. */
export function isWaiting() {
  return waiting.size > 0;
}

export function pendingQuestion() {
  const first = [...waiting.values()].sort((a, b) => a.askedAt - b.askedAt)[0];
  return first ? first.question : null;
}
