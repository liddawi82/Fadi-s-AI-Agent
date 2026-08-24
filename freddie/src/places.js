// Restaurant lookups for the live-call "suggest a place nearby" feature.
//
// Separate from find_place in brain/tools.js (which finds ONE specific named
// business for booking). This is for the fuzzier ask — "what's good near
// here?" — so it pulls several candidates and filters for ones that are
// actually well reviewed, not just the first result.

import { config } from './config.js';
import { log } from './util/log.js';

const FIELD_MASK = [
  'places.displayName',
  'places.rating',
  'places.userRatingCount',
  'places.formattedAddress',
  'places.priceLevel',
  'places.currentOpeningHours.openNow',
].join(',');

// Below this, a rating isn't meaningful — a single 5-star review means
// nothing. Above it, we trust the rating enough to recommend on it.
const MIN_REVIEWS = 20;
const MIN_RATING = 4.3;

/**
 * Look up well-reviewed restaurants near a place mentioned on a call.
 * @param {string} location free text — a neighbourhood, address, landmark, city
 * @param {string} [cuisine] optional — "Italian", "seafood", etc.
 */
export async function findRestaurants(location, cuisine) {
  if (!config.places.apiKey) {
    return {
      ok: false,
      message:
        'No Google Places key is configured yet. Do not promise a recommendation — tell them you cannot look that up right now.',
    };
  }
  if (!location || !location.trim()) {
    return { ok: false, message: 'No location given — ask them where, then try again.' };
  }

  const textQuery = cuisine ? `${cuisine} restaurants near ${location}` : `restaurants near ${location}`;

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.places.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery, includedType: 'restaurant', maxResultCount: 10 }),
    });

    if (!res.ok) {
      const detail = await res.text();
      log.warn('Restaurant lookup failed:', res.status, detail.slice(0, 200));
      return { ok: false, message: `The lookup failed (${res.status}). Tell them you couldn't pull that up right now.` };
    }

    const data = await res.json();
    const places = (data.places || []).map((p) => ({
      name: p.displayName?.text || 'unknown',
      rating: p.rating ?? null,
      reviewCount: p.userRatingCount ?? 0,
      address: p.formattedAddress || '',
      priceLevel: p.priceLevel || null,
      openNow: p.currentOpeningHours?.openNow ?? null,
    }));

    if (!places.length) {
      return { ok: false, message: `Nothing came up for "${location}". Say so — don't invent a name.` };
    }

    // Prefer genuinely well-reviewed places; fall back to best-available
    // rather than returning nothing if the area is thin on reviews.
    const wellReviewed = places.filter((p) => p.rating >= MIN_RATING && p.reviewCount >= MIN_REVIEWS);
    const ranked = (wellReviewed.length ? wellReviewed : places)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 3);

    return { ok: true, restaurants: ranked };
  } catch (err) {
    log.warn('Restaurant lookup threw:', err.message);
    return { ok: false, message: "The lookup failed. Tell them you couldn't pull that up right now." };
  }
}
