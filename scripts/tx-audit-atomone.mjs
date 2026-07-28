/**
 * AtomOne testnet feature tests via broadcast_tx_sync (nodes often disable tx indexing).
 * AUDIT_MNEMONIC from env only — never logged.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Secp256k1HdWallet } = require('@cosmjs/amino');
const { stringToPath } = require('@cosmjs/crypto');
const { SigningStargateClient, GasPrice } = require('@cosmjs/stargate');
const { toBase64, toHex } = require('@cosmjs/encoding');
const { TxRaw } = require('cosmjs-types/cosmos/tx/v1beta1/tx');
const fs = require('fs');

const mnemonic = (process.env.AUDIT_MNEMONIC || '').trim();
if (!mnemonic) {
  console.error('NO_MNEMONIC');
  process.exit(1);
}

const PREFIX = 'atone';
const path = stringToPath("m/44'/118'/0'/0/0");
const VAL = 'atonevaloper1z946llvyk5v2hatfha3xhgq5dd5mll53qr4w63';
const VAL2 = 'atonevaloper1zf944e6f63hevwpqjt64s8vvk2szs27lzzql3w';
const RPC = process.env.ATOMONE_RPC || 'https://testnet-atomone-rpc.konsortech.xyz';
const LCD = process.env.ATOMONE_LCD || 'https://atomone-testnet-api.itrocket.net';
const report = { steps: [], errors: [], address: null, hashes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (step, data = {}) => {
  const row = { step, t: new Date().toISOString(), ...data };
  report.steps.push(row);
  console.log(JSON.stringify(row));
};

async function lcd(p) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(LCD + p, { headers: { 'User-Agent': 'Mozilla/5.0 ShazoesAudit/1.0' } });
    if (r.status === 429) {
      await sleep(2500 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error('LCD ' + r.status + ' ' + p);
    return r.json();
  }
  throw new Error('LCD rate limited');
}

async function broadcastSync(txBytes) {
  const b64 = toBase64(txBytes);
  const body = { jsonrpc: '2.0', id: 1, method: 'broadcast_tx_sync', params: { tx: b64 } };
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  if (res.error) throw new Error(JSON.stringify(res.error));
  if (res.result?.code && res.result.code !== 0) {
    throw new Error(`code ${res.result.code}: ${res.result.log || res.result.codespace}`);
  }
  return res.result;
}

async function main() {
  const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: PREFIX, hdPaths: [path] });
  const [acct] = await wallet.getAccounts();
  report.address = acct.address;
  log('address', { address: acct.address });

  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString('0.025uphoton'),
  });

  async function signAndSync(msgs, memo, feeOverride) {
    // refresh sequence from LCD each time
    const auth = await lcd(`/cosmos/auth/v1beta1/accounts/${acct.address}`);
    const seq = Number(auth.account.sequence);
    log('sign_seq', { seq, memo });
    const fee = feeOverride || {
      amount: [{ denom: 'uphoton', amount: '5000' }],
      gas: '250000',
    };
    const txRaw = await client.sign(acct.address, msgs, fee, memo);
    const txBytes = TxRaw.encode(txRaw).finish();
    const result = await broadcastSync(txBytes);
    log('broadcast', { memo, hash: result.hash, code: result.code });
    report.hashes.push({ memo, hash: result.hash });
    // wait for sequence bump
    for (let i = 0; i < 15; i++) {
      await sleep(1500);
      const a2 = await lcd(`/cosmos/auth/v1beta1/accounts/${acct.address}`);
      if (Number(a2.account.sequence) > seq) {
        log('seq_advanced', { from: seq, to: Number(a2.account.sequence) });
        return result;
      }
    }
    log('seq_wait_timeout', { seq });
    return result;
  }

  const bal0 = await lcd(`/cosmos/bank/v1beta1/balances/${acct.address}`);
  log('balance_before', { balances: bal0.balances });

  // 1) SEND self 1000 uatone
  try {
    await signAndSync(
      [
        {
          typeUrl: '/cosmos.bank.v1beta1.MsgSend',
          value: {
            fromAddress: acct.address,
            toAddress: acct.address,
            amount: [{ denom: 'uatone', amount: '1000' }],
          },
        },
      ],
      'sz-send',
      { amount: [{ denom: 'uphoton', amount: '3000' }], gas: '100000' }
    );
    log('send_ok', {});
  } catch (e) {
    report.errors.push({ step: 'send', err: String(e.message || e).slice(0, 300) });
    log('send_fail', { err: String(e.message || e).slice(0, 300) });
  }

  // 2) DELEGATE 50000 uatone to ITRocket
  try {
    await signAndSync(
      [
        {
          typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
          value: {
            delegatorAddress: acct.address,
            validatorAddress: VAL,
            amount: { denom: 'uatone', amount: '50000' },
          },
        },
      ],
      'sz-delegate',
      { amount: [{ denom: 'uphoton', amount: '8000' }], gas: '300000' }
    );
    log('delegate_ok', { val: VAL, amount: '50000' });
  } catch (e) {
    report.errors.push({ step: 'delegate', err: String(e.message || e).slice(0, 300) });
    log('delegate_fail', { err: String(e.message || e).slice(0, 300) });
  }

  try {
    const d = await lcd(`/cosmos/staking/v1beta1/delegations/${acct.address}`);
    log('delegations', {
      items: (d.delegation_responses || []).map((x) => ({
        val: x.delegation.validator_address,
        bal: x.balance,
      })),
    });
  } catch (e) {
    log('delegations_err', { err: String(e.message || e) });
  }

  // 3) UNDELEGATE 25000
  try {
    await signAndSync(
      [
        {
          typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
          value: {
            delegatorAddress: acct.address,
            validatorAddress: VAL,
            amount: { denom: 'uatone', amount: '25000' },
          },
        },
      ],
      'sz-undelegate',
      { amount: [{ denom: 'uphoton', amount: '8000' }], gas: '300000' }
    );
    log('undelegate_ok', { amount: '25000' });
  } catch (e) {
    report.errors.push({ step: 'undelegate', err: String(e.message || e).slice(0, 300) });
    log('undelegate_fail', { err: String(e.message || e).slice(0, 300) });
  }

  // 4) REDELEGATE 10000 remaining to linkednode
  try {
    await signAndSync(
      [
        {
          typeUrl: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
          value: {
            delegatorAddress: acct.address,
            validatorSrcAddress: VAL,
            validatorDstAddress: VAL2,
            amount: { denom: 'uatone', amount: '10000' },
          },
        },
      ],
      'sz-redelegate',
      { amount: [{ denom: 'uphoton', amount: '10000' }], gas: '350000' }
    );
    log('redelegate_ok', { to: VAL2 });
  } catch (e) {
    report.errors.push({ step: 'redelegate', err: String(e.message || e).slice(0, 300) });
    log('redelegate_fail', { err: String(e.message || e).slice(0, 300) });
  }

  // 5) WITHDRAW rewards from VAL (may be tiny)
  try {
    await signAndSync(
      [
        {
          typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
          value: {
            delegatorAddress: acct.address,
            validatorAddress: VAL,
          },
        },
      ],
      'sz-withdraw',
      { amount: [{ denom: 'uphoton', amount: '5000' }], gas: '200000' }
    );
    log('withdraw_ok', {});
  } catch (e) {
    report.errors.push({ step: 'withdraw', err: String(e.message || e).slice(0, 300) });
    log('withdraw_fail', { err: String(e.message || e).slice(0, 300) });
  }

  const finalBal = await lcd(`/cosmos/bank/v1beta1/balances/${acct.address}`);
  const finalDel = await lcd(`/cosmos/staking/v1beta1/delegations/${acct.address}`).catch(() => ({}));
  const unbond = await lcd(
    `/cosmos/staking/v1beta1/delegators/${acct.address}/unbonding_delegations`
  ).catch(() => ({}));
  const auth = await lcd(`/cosmos/auth/v1beta1/accounts/${acct.address}`);
  log('final', {
    sequence: auth.account.sequence,
    balances: finalBal.balances,
    dels: (finalDel.delegation_responses || []).map((x) => ({
      val: x.delegation.validator_address,
      bal: x.balance,
    })),
    unbond_count: (unbond.unbonding_responses || []).length,
    unbond: unbond.unbonding_responses || [],
  });

  fs.writeFileSync('/tmp/wallet-audit/tx-report.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  // also copy redacted report to explorer-audit
  fs.mkdirSync('/home/hermes/explorer-audit/reports', { recursive: true });
  fs.writeFileSync(
    '/home/hermes/explorer-audit/reports/wallet-tx-atomone-testnet.json',
    JSON.stringify(report, null, 2)
  );
  console.log('DONE errors=' + report.errors.length + ' hashes=' + report.hashes.length);
  try {
    client.disconnect();
  } catch {}
  process.exit(report.errors.length ? 2 : 0);
}

main().catch((e) => {
  console.error('FATAL', String(e.message || e).slice(0, 400));
  report.errors.push({ step: 'fatal', err: String(e.message || e).slice(0, 400) });
  fs.writeFileSync('/tmp/wallet-audit/tx-report.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  process.exit(1);
});
