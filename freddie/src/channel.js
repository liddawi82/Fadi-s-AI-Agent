// Which channel Freddie is currently talking to you on.
//
// He works over both WhatsApp and SMS. Whichever one you message him on is the
// one he answers on — including for call reports that arrive minutes later,
// long after the original message.

import { log } from './util/log.js';

let current = 'whatsapp';

/** Work out the channel from a Twilio webhook's From field. */
export function detectChannel(from) {
  return String(from || '').toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';
}

export function setChannel(channel) {
  if (channel !== current) {
    log.info(`Switching to ${channel} — that's where the last message came from.`);
    current = channel;
  }
}

export function currentChannel() {
  return current;
}

/** Twilio wants "whatsapp:+1555..." for WhatsApp and a bare number for SMS. */
export function addressFor(phone, channel = current) {
  return channel === 'whatsapp' ? `whatsapp:${phone}` : phone;
}
