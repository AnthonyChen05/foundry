/**
 * Sorted ULID-ish ids: 10 chars of timestamp (ms) + 16 chars of randomness,
 * Crockford base32, lexicographically sortable. Text ids everywhere per
 * data-model.md. No external dependency (crypto.getRandomValues is available
 * on Node 18+ globally).
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;

function encodeTime(ms: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function randomChars(): string {
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/** New id. Monotonic within the process even for ids generated in the same ms. */
export function ulid(): string {
  const now = Date.now();
  // If we already emitted an id this ms, increment the ms to preserve ordering
  // (standard ULID monotonic trick).
  const t = now > lastTime ? now : lastTime + 1;
  lastTime = t;
  return encodeTime(t) + randomChars();
}