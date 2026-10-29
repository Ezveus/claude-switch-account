/**
 * Passphrase-based encryption for the saved sessions.
 *
 * The passphrase goes through PBKDF2-SHA256 to give an AES-GCM-256 key. The
 * vault itself (salt, iteration count, IV, ciphertext) is plain JSON, so it
 * fits in chrome.storage.local. Nothing here touches chrome.*: the module also
 * runs under Node for the tests.
 */

export const KDF_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Derives the AES key. It stays extractable so the service worker can keep
 *  it in chrome.storage.session between its own restarts. */
async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKey(key) {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function importKey(b64) {
  return crypto.subtle.importKey("raw", fromBase64(b64), "AES-GCM", true, ["encrypt", "decrypt"]);
}

/** Encrypts `secrets` into a vault, reusing the KDF parameters of `previous`. */
export async function seal(key, secrets, previous) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(secrets))
  );
  return { v: 1, kdf: previous.kdf, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/** Decrypts a vault. Throws when the key is wrong or the data was altered. */
export async function open(key, vault) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(vault.iv) }, key, fromBase64(vault.data)
  );
  return JSON.parse(decoder.decode(plain));
}

/** Creates a new vault holding `secrets`, with a fresh salt. */
export async function create(passphrase, secrets, iterations = KDF_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, iterations);
  const kdf = { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) };
  return { key, vault: await seal(key, secrets, { kdf }) };
}

/** Re-derives the key of an existing vault and checks it by decrypting. */
export async function unlock(passphrase, vault) {
  const key = await deriveKey(passphrase, fromBase64(vault.kdf.salt), vault.kdf.iterations);
  const secrets = await open(key, vault);
  return { key, secrets };
}
