<script lang="ts" setup>
import { useTxDialog, useBlockchain } from '@/stores';
const store = useTxDialog();
const chainStore = useBlockchain();
</script>
<template>
  <!--
    :key remounts the CE whenever open() bumps nonce so Delegate/Vote forms
    never keep a previous validator_address / proposal_id selection.
  -->
  <ping-tx-dialog
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
