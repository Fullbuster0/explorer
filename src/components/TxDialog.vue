<script lang="ts" setup>
import { useTxDialog, useBlockchain } from '@/stores';
import { computed } from 'vue';
const store = useTxDialog();
const chainStore = useBlockchain();
/** Gno has no staking/delegation → no Send/Delegate dialogs. */
const isGno = computed(
  () => chainStore.current?.engine === 'gno' || chainStore.current?.engine === 'tm2'
);
</script>
<template>
  <!--
    :key remounts the CE whenever open() bumps nonce so Delegate/Vote forms
    never keep a previous validator_address / proposal_id selection.
    Fully unmounted on Gno so the floating "Send / No wallet connected" UI
    never appears.
  -->
  <ping-tx-dialog
    v-if="!isGno"
    :key="store.instanceKey"
    :type="store.type"
    :sender="store.sender"
    :endpoint="store.endpoint"
    :params="store.params"
    :hd-path="store.hdPaths"
    :registry-name="chainStore.current?.prettyName || chainStore.chainName"
    @view="store.view"
    @confirmed="store.confirmed"
  ></ping-tx-dialog>
</template>
