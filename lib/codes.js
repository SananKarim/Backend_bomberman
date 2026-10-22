/* Human-readable room codes: 4 chars from an ambiguity-free alphabet.
   Generation takes a `taken` predicate so the caller (a Realtime Database
   transaction in the Cloud Function) guarantees collision safety. */
'use strict';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I O 0 1
const CODE_LEN = 4;

function randomCode(rng) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return s;
}

function isValidCode(code) {
  return typeof code === 'string'
    && code.length === CODE_LEN
    && code.split('').every((c) => ALPHABET.includes(c));
}

/** Collision-safe generation: retries up to maxTries against `taken`. */
function generateUniqueCode(rng, taken, maxTries = 40) {
  for (let i = 0; i < maxTries; i++) {
    const code = randomCode(rng);
    if (!taken(code)) return code;
  }
  return null;      // caller surfaces "busy, try again" — 30^4 space makes this rare
}

module.exports = { randomCode, isValidCode, generateUniqueCode, ALPHABET, CODE_LEN };
