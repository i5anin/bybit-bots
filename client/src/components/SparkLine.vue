<script setup lang="ts">
import { computed } from 'vue';
import { sparkPoints } from '../format';

const props = withDefaults(defineProps<{ values: readonly number[]; width?: number; height?: number }>(), {
  width: 130,
  height: 26,
});

const points = computed(() => sparkPoints(props.values, props.width, props.height));
const rising = computed(() => (props.values.at(-1) ?? 0) >= (props.values[0] ?? 0));
</script>

<template>
  <svg v-if="points" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img"
    :aria-label="rising ? 'рост' : 'снижение'">
    <polyline :points="points" fill="none" :stroke="rising ? 'var(--up)' : 'var(--down)'" stroke-width="1.5" />
  </svg>
</template>
