// Things Freddie is asked to do while he's on the phone.
//
// He can't dial a second number while he's talking to you, so instructions
// given by voice are written down here and carried out the moment the call
// ends. This is what stops him agreeing to something and then quietly not
// doing it — the failure that made him claim he'd rung someone he hadn't.

import { log } from '../util/log.js';

/** callId -> [{ to, goal, calleeName, language }] */
const queued = new Map();

export function noteTask(callId, task) {
  if (!callId) return false;
  const list = queued.get(callId) || [];
  list.push(task);
  queued.set(callId, list);
  log.info(`Noted for after the call: call ${task.calleeName || task.to} — ${task.goal}`);
  return true;
}

/** Takes the tasks for a call and clears them, so they can't run twice. */
export function drainTasks(callId) {
  if (!callId) return [];
  const list = queued.get(callId) || [];
  queued.delete(callId);
  return list;
}

export function pendingCount(callId) {
  return (queued.get(callId) || []).length;
}
