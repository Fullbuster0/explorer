import { fromBase64, fromBech32, toBase64, toBech32, toHex } from '@cosmjs/encoding';
import { Ripemd160, sha256 } from '@cosmjs/crypto';

export function decodeAddress(address: string) {
  return fromBech32(address);
}

export function operatorAddressToAccount(operAddress?: string) {
  if (!operAddress) return '';
  const { prefix, data } = fromBech32(operAddress);
  if (prefix === 'iva') {
    // handle special cases
    return toBech32('iaa', data);
  }
  if (prefix === 'crocncl') {
    // handle special cases
    return toBech32('cro', data);
  }
  return toBech32(prefix.replace('valoper', ''), data);
}

export function consensusPubkeyToHexAddress(consensusPubkey?: { '@type': string; key: string }) {
  if (!consensusPubkey) return '';
  let raw = '';
  const t = consensusPubkey['@type'] || '';
  // Cosmos ed25519 + Gno/TM2 `/tm.PubKeyEd25519` (normalized to cosmos type in gno adapter,
  // but accept the raw TM2 type too just in case).
  if (
    t === '/cosmos.crypto.ed25519.PubKey' ||
    t === '/tm.PubKeyEd25519' ||
    t.endsWith('ed25519.PubKey') ||
    t.endsWith('PubKeyEd25519')
  ) {
    const key = (consensusPubkey as any).key || (consensusPubkey as any).value;
    if (!key) return raw;
    const pubkey = fromBase64(key);
    if (pubkey) return toHex(sha256(pubkey)).slice(0, 40).toUpperCase();
  }

  if (t === '/cosmos.crypto.secp256k1.PubKey' || t.endsWith('secp256k1.PubKey')) {
    const key = (consensusPubkey as any).key || (consensusPubkey as any).value;
    if (!key) return raw;
    const pubkey = fromBase64(key);
    if (pubkey) return toHex(new Ripemd160().update(sha256(pubkey)).digest());
  }
  return raw;
}

// not work as expected, will fix later or remove
export function consumerKeyToBase64Address(consumerKey?: Record<string, string>) {
  if (!consumerKey) return '';
  let raw = '';
  if (consumerKey.ed25519) {
    const pubkey = fromBase64(consumerKey.ed25519);
    if (pubkey) return toBase64(sha256(pubkey).slice(0, 20));
  }

  if (consumerKey.secp256k1) {
    const pubkey = fromBase64(consumerKey.secp256k1);
    if (pubkey)
      return toBase64(new Ripemd160().update(sha256(pubkey)).digest());
  }
  return raw;
}

export function pubKeyToValcons(consensusPubkey: { '@type': string; key: string }, prefix: string) {
  if (consensusPubkey && consensusPubkey.key) {
    const pubkey = fromBase64(consensusPubkey.key);
    if (pubkey) {
      const t = consensusPubkey['@type'] || '';
      if (t.endsWith('secp256k1.PubKey')) {
        return toBech32(prefix, new Ripemd160().update(sha256(pubkey)).digest());
      }
      const addressData = sha256(pubkey).slice(0, 20);
      return toBech32(prefix, addressData);
    }
  }
  return '';
}

export function valconsToBase64(address: string) {
  if (address) return toBase64(fromBech32(address).data);
  return '';
}

export function toETHAddress(cosmosAddress: string) {
  return `0x${toHex(fromBech32(cosmosAddress).data)}`;
}

export function addressEnCode(prefix: string, pubkey: Uint8Array) {
  return toBech32(prefix, pubkey);
}
