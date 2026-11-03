// The device (sync design 3.2; app backends design 3.5): a P-256 key made
// with WebCrypto (browsers and Node alike), its proofs over the connection's
// challenge nonce, the server-minted id and rotating secret, and the
// reconcile after a `device_conflict`. The rules are atlas-core's
// `sync::device`; the proofs are byte-compatible with its `DeviceKey::sign`.

import type { DeviceResults, PublicJwk } from "./generated/protocol.js";
import type { OutboxEntry, StoreTx } from "./types.js";
import { base64url, fromBase64url } from "./ids.js";

export const HELLO_PROOF_TYPE = "device-hello+jwt";
export const REGISTRATION_PROOF_TYPE = "device-registration+jwt";

/** What a store keeps of the key: the `CryptoKey` itself where it can (non-extractable), else its JWK. */
export type HeldKey =
  | { kind: "crypto"; privateKey: CryptoKey; publicJwk: PublicJwk }
  | { kind: "jwk"; privateJwk: JsonWebKey; publicJwk: PublicJwk };

/** The device the service minted, as the store keeps it (meta `device`). */
export interface HeldDevice {
  id: string;
  secret: string;
  generation: number;
  /** The service's `device_epoch`, which every push carries. */
  epoch: number;
}

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** P-256's group order, for the low-S signature atlas-core's verifier expects. */
const ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s)
    throw new Error(
      "@remotehost/sdk/sync needs WebCrypto (crypto.subtle): a browser, or Node 20 or later",
    );
  return s;
}

/** A new device key; non-extractable when the store keeps `CryptoKey`s. */
export async function makeKey(keepsCryptoKeys: boolean): Promise<HeldKey> {
  const pair = (await subtle().generateKey(ALG, !keepsCryptoKeys, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = (await subtle().exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const publicJwk: PublicJwk = { kty: "EC", crv: "P-256", x: pub.x!, y: pub.y! };
  if (keepsCryptoKeys) return { kind: "crypto", privateKey: pair.privateKey, publicJwk };
  const privateJwk = (await subtle().exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { kind: "jwk", privateJwk, publicJwk };
}

async function privateKey(key: HeldKey): Promise<CryptoKey> {
  if (key.kind === "crypto") return key.privateKey;
  return subtle().importKey("jwk", key.privateJwk, ALG, false, ["sign"]);
}

/** RFC 7638's thumbprint of a P-256 public key. */
export async function thumbprint(jwk: PublicJwk): Promise<string> {
  const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(canonical));
  return base64url(new Uint8Array(digest));
}

function lowS(signature: Uint8Array): Uint8Array {
  const hex = Array.from(signature.subarray(32), (b) => b.toString(16).padStart(2, "0")).join("");
  const s = BigInt(`0x${hex}`);
  if (s <= ORDER / 2n) return signature;
  const flipped = (ORDER - s).toString(16).padStart(64, "0");
  const out = new Uint8Array(signature);
  for (let i = 0; i < 32; i++) out[32 + i] = parseInt(flipped.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A compact JWS (ES256, low S) over `claims`, encoded in the order atlas-core's serde writes them. */
export async function sign(
  key: HeldKey,
  typ: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "ES256", typ })));
  const payload = base64url(enc.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const raw = new Uint8Array(await subtle().sign(SIGN, await privateKey(key), enc.encode(input)));
  return `${input}.${base64url(lowS(raw))}`;
}

/** A registering `hello`'s proof: the key's thumbprint and the challenge nonce. */
export async function proveRegistration(key: HeldKey, nonce: string): Promise<string> {
  return sign(key, REGISTRATION_PROOF_TYPE, {
    kind: "registration",
    jkt: await thumbprint(key.publicJwk),
    nonce,
  });
}

/** A returning `hello`'s proof over `(device id, generation, nonce)`. */
export function proveHello(
  key: HeldKey,
  deviceId: string,
  generation: number,
  nonce: string,
): Promise<string> {
  return sign(key, HELLO_PROOF_TYPE, { kind: "hello", device_id: deviceId, generation, nonce });
}

/** Verifies a proof against a public key: for tests and the fake server. */
export async function verify(jwk: PublicJwk, jws: string): Promise<boolean> {
  const [h, p, s] = jws.split(".");
  if (!h || !p || !s) return false;
  const key = await subtle().importKey("jwk", { ...jwk, ext: true }, ALG, false, ["verify"]);
  return subtle().verify(SIGN, key, fromBase64url(s), new TextEncoder().encode(`${h}.${p}`));
}

// ---- Store meta ------------------------------------------------------------

export const META = {
  device: "device",
  key: "device_key",
  /** The device a conflict ended, while its reconcile runs. */
  ending: "device_ending",
  outboxEpoch: "outbox_epoch",
  nextDeviceSeq: "next_device_seq",
  cursors: "cursors",
  groups: "groups",
} as const;

export function heldDevice(tx: StoreTx): HeldDevice | null {
  return (tx.getMeta(META.device) as HeldDevice | undefined) ?? null;
}

/**
 * A welcome's device: kept with its new secret and generation before
 * anything is pushed (the secret rotates on every `hello`). A device the
 * client did not hold before takes the outbox, numbered from the service's
 * `last_device_seq + 1`.
 */
export function takeWelcomeDevice(
  tx: StoreTx,
  w: {
    device: { id: string; secret: string; generation: number };
    device_epoch: number;
    outbox_epoch: number;
    last_device_seq: number;
  },
): { renumbered: Map<number, number> } {
  const before = heldDevice(tx);
  const renumbered = new Map<number, number>();
  if (!before || before.id !== w.device.id) {
    let seq = w.last_device_seq + 1;
    const entries = tx.outbox().map((e) => {
      renumbered.set(e.deviceSeq, seq);
      return { ...e, deviceSeq: seq++ };
    });
    tx.replaceOutbox(entries);
    tx.setMeta(META.nextDeviceSeq, seq);
  } else {
    const next = Number(tx.getMeta(META.nextDeviceSeq) ?? 1);
    tx.setMeta(META.nextDeviceSeq, Math.max(next, w.last_device_seq + 1));
  }
  tx.setMeta(META.device, {
    id: w.device.id,
    secret: w.device.secret,
    generation: w.device.generation,
    epoch: w.device_epoch,
  } satisfies HeldDevice);
  tx.setMeta(META.outboxEpoch, w.outbox_epoch);
  tx.setMeta(META.ending, null);
  return { renumbered };
}

/**
 * Ends the held device after a `device_conflict` or a stale secret: its key
 * and secret are forgotten (the next registration makes a new key) and it is
 * kept as the one being reconciled.
 */
export function endDevice(tx: StoreTx): HeldDevice | null {
  const d = heldDevice(tx);
  if (d) tx.setMeta(META.ending, d);
  tx.setMeta(META.device, null);
  tx.setMeta(META.key, null);
  return d;
}

export interface Reconciled {
  applied: number[];
  refused: DeviceResults["refused"];
}

/**
 * A `device_results` page against the outbox: what the old device applied
 * or refused leaves the outbox (final, revision 3.4); the rest stays, to be
 * numbered again for the next device at its welcome.
 */
export function reconcilePage(tx: StoreTx, answer: DeviceResults): Reconciled {
  const applied = answer.applied.map((a) => a.device_seq);
  const refusedSeqs = new Set(answer.refused.map((r) => r.device_seq));
  const kept: OutboxEntry[] = [];
  for (const e of tx.outbox()) {
    if (applied.includes(e.deviceSeq) || refusedSeqs.has(e.deviceSeq)) continue;
    kept.push(e);
  }
  tx.replaceOutbox(kept);
  return { applied, refused: answer.refused };
}
