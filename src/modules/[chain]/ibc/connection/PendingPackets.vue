<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useBlockchain } from '@/stores';

const props = defineProps<{
  chain: string;
  connectionId: string;
  clientId?: string;
  counterpartyClientId?: string;
  channels?: string[]; // channel_ids on this connection (local side)
}>();

const chainStore = useBlockchain();

type PendingMsg = {
  txHash: string;
  msgType: string;
  signer: string;
  channel?: string;
  port?: string;
  sequence?: string | number;
  match: 'connection' | 'client' | 'channel';
};

const rows = ref<PendingMsg[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const lastPoll = ref<number>(0);

let timer: any = null;
let inflight = false;

const IBC_TYPES = new Set([
  '/ibc.core.channel.v1.MsgRecvPacket',
  '/ibc.core.channel.v1.MsgAcknowledgement',
  '/ibc.core.channel.v1.MsgTimeout',
  '/ibc.core.channel.v1.MsgTimeoutOnClose',
  '/ibc.core.client.v1.MsgUpdateClient',
  '/ibc.core.connection.v1.MsgConnectionOpenAck',
  '/ibc.core.connection.v1.MsgConnectionOpenConfirm',
]);

function rpcAddr(): string {
  const list: any[] = (chainStore.current as any)?.endpoints?.rpc || [];
  const preferred = list.find((e) => (e?.address || '').includes('shazoes')) || list[0];
  return (preferred?.address || '').replace(/\/$/, '');
}

function lcdAddr(): string {
  return (chainStore.endpoint?.address || '').replace(/\/$/, '');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decodeTx(lcd: string, b64: string): Promise<any | null> {
  try {
    const r = await fetch(`${lcd}/cosmos/tx/v1beta1/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_bytes: b64 }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function messageMatches(msg: any): PendingMsg['match'] | null {
  const t = msg?.['@type'] || '';
  if (!IBC_TYPES.has(t)) return null;

  const cid = props.connectionId;
  const cliId = props.clientId;
  const cpCliId = props.counterpartyClientId;
  const chSet = new Set(props.channels || []);

  // 1) connection-level messages
  const connFields = [
    msg?.connection_id,
    msg?.counterparty_connection_id,
    msg?.previous_connection_id,
  ];
  if (connFields.includes(cid)) return 'connection';

  // 2) MsgUpdateClient — match our client_id or the counterparty client_id
  if (t === '/ibc.core.client.v1.MsgUpdateClient') {
    if (cliId && msg?.client_id === cliId) return 'client';
    if (cpCliId && msg?.client_id === cpCliId) return 'client';
    return null;
  }

  // 3) packet msgs — match by (src/dst) channel that belongs to this connection
  const pkt = msg?.packet || {};
  const srcCh = pkt?.source_channel;
  const dstCh = pkt?.destination_channel;
  if (srcCh && chSet.has(srcCh)) return 'channel';
  if (dstCh && chSet.has(dstCh)) return 'channel';
  return null;
}

function extractPacketInfo(msg: any) {
  const p = msg?.packet || {};
  const t = msg['@type'];
  // for MsgRecvPacket: dst is our side; for Ack/Timeout: src is our side
  const isRecv = t === '/ibc.core.channel.v1.MsgRecvPacket';
  const channel = isRecv ? p.destination_channel : p.source_channel;
  const port = isRecv ? p.destination_port : p.source_port;
  return { channel, port, sequence: p.sequence };
}

async function poll() {
  if (inflight) return;
  inflight = true;
  const rpc = rpcAddr();
  const lcd = lcdAddr();
  if (!rpc || !lcd) {
    inflight = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const r = await fetch(`${rpc}/unconfirmed_txs?limit=100`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`RPC http ${r.status}`);
    const j = await r.json();
    const raw: string[] = j?.result?.txs || [];
    total.value = parseInt(j?.result?.total || j?.result?.n_txs || '0', 10) || raw.length;

    if (!raw.length) {
      rows.value = [];
      lastPoll.value = Date.now();
      return;
    }

    // decode in parallel but bounded
    const decoded = await Promise.all(raw.map((b) => decodeTx(lcd, b).then((d) => ({ b, d }))));
    const collected: PendingMsg[] = [];
    for (const { b, d } of decoded) {
      const msgs: any[] = d?.tx?.body?.messages || [];
      if (!msgs.length) continue;
      let hash = '';
      let matched: PendingMsg[] = [];
      for (const m of msgs) {
        const match = messageMatches(m);
        if (!match) continue;
        if (!hash) hash = await sha256Hex(b64ToBytes(b));
        const signer =
          m?.signer || m?.sender || m?.relayer || (d?.tx?.auth_info?.signer_infos?.[0]?.public_key ? '' : '') || '';
        const { channel, port, sequence } = extractPacketInfo(m);
        matched.push({
          txHash: hash,
          msgType: (m['@type'] || '').split('.').pop() || '',
          signer,
          channel,
          port,
          sequence,
          match,
        });
      }
      collected.push(...matched);
    }
    rows.value = collected;
    lastPoll.value = Date.now();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
    inflight = false;
  }
}

function start() {
  stop();
  poll();
  timer = setInterval(poll, 6000);
}
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

onMounted(start);
onUnmounted(stop);
watch(
  () => [props.connectionId, chainStore.endpoint?.address, (chainStore.current as any)?.chainName],
  () => {
    rows.value = [];
    poll();
  }
);

const secondsAgo = computed(() => {
  if (!lastPoll.value) return null;
  return Math.max(0, Math.floor((Date.now() - lastPoll.value) / 1000));
});
// tick a reactive re-render so "Xs ago" updates
const tick = ref(0);
setInterval(() => (tick.value++), 1000);
const ago = computed(() => {
  void tick.value;
  if (!lastPoll.value) return '';
  const s = Math.max(0, Math.floor((Date.now() - lastPoll.value) / 1000));
  return `${s}s`;
});

function shortAddr(a: string) {
  if (!a) return '—';
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

function chipClass(m: PendingMsg): string {
  if (m.msgType === 'MsgRecvPacket') return 'sz-chip--info';
  if (m.msgType === 'MsgAcknowledgement') return 'sz-chip--ok';
  if (m.msgType.startsWith('MsgTimeout')) return 'sz-chip--warn';
  return '';
}
</script>

<template>
  <div class="sz-section overflow-hidden mb-4">
    <div class="sz-section-head">
      <div>
        <div class="sz-section-kicker">{{ $t('ibc.mempool') }}</div>
        <div class="sz-section-title">{{ $t('ibc.pending_packets') }}</div>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="loading" class="loading loading-spinner loading-xs text-secondary"></span>
        <span v-else-if="ago" class="text-[11px] text-secondary font-mono">{{ ago }}</span>
        <span class="sz-chip sz-chip--info font-mono !text-[10px]">
          {{ rows.length }} / {{ total }}
        </span>
      </div>
    </div>

    <div v-if="error" class="mx-4 my-3 flex items-start gap-2 text-error text-[12px]">
      <Icon icon="mdi:alert-circle-outline" class="text-base shrink-0 mt-0.5" />
      <span class="font-mono break-all">{{ error }}</span>
    </div>

    <!-- empty mempool -->
    <div
      v-if="!error && !rows.length"
      class="flex flex-col items-center gap-1 py-8 text-secondary text-[12.5px]"
    >
      <Icon icon="mdi:tray-full" class="text-2xl opacity-40" />
      <div v-if="total === 0">{{ $t('ibc.mempool_empty') }}</div>
      <div v-else>{{ $t('ibc.mempool_no_match', { total }) }}</div>
      <div class="text-[10.5px] opacity-60">{{ $t('ibc.mempool_hint') }}</div>
    </div>

    <div v-else-if="rows.length" class="overflow-x-auto">
      <table class="sz-table min-w-[720px]">
        <thead>
          <tr>
            <th>{{ $t('ibc.msg_type') }}</th>
            <th>{{ $t('ibc.state') }}</th>
            <th>{{ $t('ibc.channel_id') }}</th>
            <th>{{ $t('ibc.sequence') }}</th>
            <th>{{ $t('ibc.relayer') }}</th>
            <th class="text-right">{{ $t('ibc.txhash') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(m, i) in rows" :key="m.txHash + i">
            <td>
              <span class="sz-chip !text-[10px]" :class="chipClass(m)">{{ m.msgType }}</span>
            </td>
            <td class="text-[11.5px] uppercase text-secondary">{{ m.match }}</td>
            <td class="font-mono text-[12px]">
              <span v-if="m.channel">{{ m.channel }}<span class="opacity-50">/{{ m.port }}</span></span>
              <span v-else class="text-secondary">—</span>
            </td>
            <td class="font-mono text-[12px]">{{ m.sequence ?? '—' }}</td>
            <td class="font-mono text-[11.5px]">{{ shortAddr(m.signer) }}</td>
            <td class="text-right">
              <RouterLink
                :to="`/${chainStore.chainName}/tx/${m.txHash}`"
                class="font-mono text-[11.5px] text-primary no-underline hover:underline"
              >
                {{ m.txHash.slice(0, 10) }}…
              </RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
