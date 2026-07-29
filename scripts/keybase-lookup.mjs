#!/usr/bin/env node
/**
 * keybase-lookup.mjs — Find a Keybase identity hash for a validator logo override.
 *
 * Usage:
 *   node scripts/keybase-lookup.mjs <keybase-username>
 *
 * The Cosmos "identity" is the last 16 hex chars of a Keybase PGP key fingerprint.
 * This tool lists ALL fingerprints for a user so you can pick the right one.
 *
 * Easiest path: copy the identity directly from an existing Cosmos explorer
 * (AtomOne / Cosmos Hub / ping.pub) validator page — that's the proven value.
 */
const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/keybase-lookup.mjs <keybase-username>');
  process.exit(1);
}

const q = encodeURIComponent(arg);
const url = `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${q}&fields=basics,profile,public_keys,pictures`;

fetch(url, { headers: { 'User-Agent': 'ShazoesExplorer/1.0' } })
  .then((r) => r.json())
  .then((data) => {
    const u = data.them?.[0];
    if (!u) {
      console.log(`No Keybase user found for "${arg}".`);
      console.log(`Try: https://keybase.io/search?q=${q}`);
      process.exit(0);
    }
    console.log(`Keybase username : ${u.basics?.username}`);
    if (u.profile?.full_name) console.log(`Full name        : ${u.profile.full_name}`);
    if (u.pictures?.primary?.url) console.log(`Avatar           : ${u.pictures.primary.url}`);

    const pk = u.public_keys || {};
    const fps = new Set();
    if (pk.eldest_key_fingerprint) fps.add(pk.eldest_key_fingerprint);
    if (pk.primary?.key_fingerprint) fps.add(pk.primary.key_fingerprint);
    for (const sub of Object.values(pk.subkeys || {})) {
      if (sub?.key_fingerprint) fps.add(sub.key_fingerprint);
    }
    for (const sib of Object.values(pk.sibkeys || {})) {
      if (sib?.key_fingerprint) fps.add(sib.key_fingerprint);
    }

    if (fps.size === 0) {
      console.log('\nNo PGP keys found for this user.');
      console.log('This user cannot be used as a Cosmos identity (needs a PGP key).');
      process.exit(0);
    }

    console.log('\nPGP key fingerprints → last-16 identity candidates:');
    for (const fp of fps) {
      const id = fp.slice(-16).toUpperCase();
      console.log(`  ${id}   (from ${fp})`);
    }
    console.log('\nPaste the matching 16-char hex into identity-overrides.json.');
    console.log('To confirm which one: check the validator on a Cosmos explorer');
    console.log('(AtomOne / Cosmos Hub / ping.pub) — its "identity" field is the answer.');
  })
  .catch((e) => {
    console.error('Lookup failed:', e.message);
    process.exit(1);
  });
