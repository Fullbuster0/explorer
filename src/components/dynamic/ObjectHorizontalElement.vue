<script lang="ts" setup>
/**
 * Horizontal object renderer.
 *
 * Previously this always rendered DaisyUI *tabs* for every key of a nested
 * object (block_id.part_set_header → tabs "total" / "hash"). On block detail
 * that looked broken (audit BLOCK-01).
 *
 * Heuristic:
 *  - If every value is a primitive (string/number/bool/null) → compact
 *    definition list (no tabs).
 *  - If any value is a nested object/array → keep tabbed drill-down so deep
 *    structures stay navigable.
 */
import DynamicComponent from './DynamicComponent.vue';
import { computed, ref, watch } from 'vue';

const props = defineProps(['value']);

const entries = computed(() => {
  const v = props.value;
  if (!v || typeof v !== 'object') return [] as { k: string; v: any }[];
  return Object.keys(v).map((k) => ({ k, v: (v as any)[k] }));
});

const allPrimitive = computed(() =>
  entries.value.every(({ v }) => {
    if (v == null) return true;
    const t = typeof v;
    return t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint';
  })
);

const tab = ref(entries.value[0]?.k || '');
watch(
  entries,
  (list) => {
    if (!list.find((e) => e.k === tab.value)) {
      tab.value = list[0]?.k || '';
    }
  },
  { immediate: true }
);

const changeTab = (val: string) => {
  tab.value = val;
};
</script>
<template>
  <!-- Compact key/value for flat objects (block hashes, part_set_header, etc.) -->
  <div v-if="allPrimitive" class="overflow-auto">
    <table class="table table-compact w-full text-sm">
      <tbody>
        <tr v-for="{ k, v } in entries" :key="k">
          <td class="capitalize whitespace-break-spaces min-w-max opacity-70">
            {{ String(k).replaceAll('_', ' ') }}
          </td>
          <td class="w-4/5">
            <div class="overflow-hidden w-auto whitespace-normal break-all">
              <DynamicComponent :value="v" />
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- Nested: keep tabs -->
  <div v-else>
    <div class="tabs">
      <a
        class="tab tab-bordered text-gray-400 capitalize"
        v-for="{ k } in entries"
        :key="k"
        :class="{ 'tab-active': tab === String(k) }"
        @click="changeTab(String(k))"
        >{{ String(k).replaceAll('_', ' ') }}</a
      >
    </div>
    <div class="min-h-[25px] mt-4">
      <div v-for="{ k, v } in entries" :key="k">
        <DynamicComponent :value="v" v-show="tab === String(k)" />
      </div>
    </div>
  </div>
</template>
