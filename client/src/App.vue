<script setup lang="ts">
import { computed } from 'vue';
import BotsTable from './components/BotsTable.vue';
import StatusBar from './components/StatusBar.vue';
import SummaryCards from './components/SummaryCards.vue';
import TradesTable from './components/TradesTable.vue';
import { useStats } from './composables/useStats';

const { stats, offline } = useStats();

const costs = computed(() => {
  const s = stats.value;
  if (s?.feePct == null || s.slippagePct == null) return '';
  return ` с учётом комиссии ${s.feePct}% и проскальзывания ${s.slippagePct}% за сторону`;
});
</script>

<template>
  <StatusBar :stats="stats" :offline="offline" />
  <main>
    <SummaryCards v-if="stats" :stats="stats" />
    <BotsTable :bots="stats?.bots ?? []" :base-asset="stats?.baseAsset ?? ''" :loading="!stats" />
    <TradesTable :trades="stats?.lastTrades ?? []" :loading="!stats" />
  </main>
  <footer>
    Обновление каждые 30 секунд. Бумажная торговля на реальных ценах Bybit spot{{ costs }}. Реальных ордеров нет.
  </footer>
</template>
