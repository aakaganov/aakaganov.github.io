/** Encode a Graffiti actor id for use in a single URL path segment (Vue Router). */
export function peerToKey(actor) {
  const bytes = new TextEncoder().encode(String(actor));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode `peerToKey` output back to the original actor string. */
export function keyToPeer(key) {
  if (key == null || String(key).trim() === "") {
    throw new Error("empty peer key");
  }
  let b64 = String(key).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Deterministic shared channel for two actors (order-independent).
 * Graffiti expects channel ids in UUID shape (same as book-club rooms); a plain string path
 * was accepted on post in some setups but not indexed for discover, so we derive a v4-shaped id.
 */
export function directMessageChannelId(actorA, actorB) {
  const [x, y] = [String(actorA), String(actorB)].sort((a, b) => a.localeCompare(b));
  const seed = `shelftalk-dm-v1\n${x}\n${y}`;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let h = (i + 1) * 0x811c9dc5;
    const chunk = `${seed}\0${i}`;
    for (let j = 0; j < chunk.length; j++) {
      h ^= chunk.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 15;
    h ^= h << 11;
    h ^= h >>> 7;
    bytes[i] = h & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
