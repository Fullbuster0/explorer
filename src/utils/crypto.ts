/**
 * XOR+sessionUUID is NOT real encryption (key lives next to ciphertext in the
 * same browser). Kept only to decode legacy values written by older builds.
 * New writes MUST be plaintext allowlisted JSON via useWalletStore.
 * Do not use encryptWallet for anything sensitive — it provides no security
 * against XSS or physical access.
 */
const SESSION_KEY_STORE = 'wallet_encryption_key';

function getSessionKey(): string {
  let key = sessionStorage.getItem(SESSION_KEY_STORE);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY_STORE, key);
  }
  return key;
}

function xorTransform(data: string, key: string): string {
  let result = '';
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

/** @deprecated No-op security — do not store secrets with this. */
export function encryptWallet(data: string): string {
  const key = getSessionKey();
  return btoa(xorTransform(data, key));
}

/** Decode legacy XOR blobs; returns input unchanged if not base64/XOR. */
export function decryptWallet(encoded: string): string {
  const key = getSessionKey();
  try {
    return xorTransform(atob(encoded), key);
  } catch {
    return encoded;
  }
}
