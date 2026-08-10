<script lang="ts" setup>
import { fromBase64, toBase64 } from '@cosmjs/encoding';
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { computed } from 'vue';
import { hashTx } from '@/libs';
import { useBlockchain, useFormatter } from '@/stores';

const props = defineProps({
  value: { type: Array<string> },
});

const format = useFormatter();
const chain = useBlockchain();

const isGno = computed(
  () => chain.current?.engine === 'gno' || chain.current?.engine === 'tm2'
);

/**
 * Gno/TM2 txs are Amino-JSON (or amino binary), not Cosmos proto — CosmJS
 * decodeTxRaw always fails → old UI painted "Injected" + hex-only, no link.
 * For Gno we always surface sha256 as base64 (TM2 native) + RouterLink.
 */
const txs = computed(() => {
  return (
    props.value?.map((x) => {
      let tx_bytes: Uint8Array;
      try {
        tx_bytes = fromBase64(String(x));
      } catch {
        return {
          hash: String(x).slice(0, 64),
          hashHref: String(x).slice(0, 64),
          tx: null as any,
          kind: 'Invalid',
          linkable: false,
        };
      }

      if (isGno.value) {
        // TM2 native hash form is base64(sha256(raw_tx_bytes))
        const digest = hashTx(tx_bytes); // uppercase hex
        let b64 = '';
        try {
          // re-hash via same path: hashTx returns hex; convert to b64 for route
          const hex = digest.replace(/^0x/i, '');
          const bytes = new Uint8Array(hex.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          }
          b64 = toBase64(bytes);
        } catch {
          b64 = digest;
        }
        return {
          hash: b64 || digest,
          hashHref: b64 || digest,
          hashHex: digest,
          tx: null as any,
          kind: 'Gno',
          linkable: true,
        };
      }

      let tx = null as any;
      let kind = 'Standard';
      try {
        tx = decodeTxRaw(tx_bytes);
      } catch {
        kind = 'Injected';
      }
      const digest = hashTx(tx_bytes);
      return {
        hash: digest,
        hashHref: digest,
        hashHex: digest,
        tx,
        kind,
        // Cosmos standard txs are linkable; injected keep plain hex historically
        linkable: kind === 'Standard',
      };
    }) || []
  );
});
</script>
<template>
  <div class="overflow-x-auto mt-4">
    <table class="table w-full sz-payload-table" density="compact" v-if="txs.length > 0">
      <thead>
        <tr>
          <th>Type</th>
          <th style="position: relative; z-index: 2">Hash</th>
          <th>Msgs</th>
          <th>Memo</th>
        </tr>
      </thead>
      <tbody class="text-sm">
        <tr v-for="(item, i) in txs" :key="i">
          <td>{{ item.kind }}</td>
          <td>
            <RouterLink
              v-if="item.linkable"
              :to="`/${chain.chainName}/tx/${encodeURIComponent(item.hashHref)}`"
              class="text-primary dark:invert break-all font-mono text-xs"
              :title="item.hashHex || item.hash"
            >
              {{ item.hash }}
            </RouterLink>
            <span v-else class="font-mono text-xs break-all">{{ item.hash }}</span>
          </td>
          <td>
            <span v-if="item.tx">
              {{ format.messages(item.tx.body.messages.map((x: any) => ({ '@type': x.typeUrl }))) }}
            </span>
            <span v-else-if="isGno" class="text-xs opacity-60">m_call / amino</span>
          </td>
          <td>
            <span v-if="item.tx">{{ item.tx.body.memo }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="text-center">No Transactions</div>
  </div>
</template>
