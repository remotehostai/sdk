// Ids the client makes: UUIDv7 (RFC 9562), time-ordered, from WebCrypto.

/** A new UUIDv7. */
export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms & 0xff;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random base64url string of `n` bytes: entry nonces, client nonces. */
export function randomToken(n = 16): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const s = atob(b64);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
