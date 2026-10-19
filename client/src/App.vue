<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BotsTable from './components/BotsTable.vue';
import GroupTable from './components/GroupTable.vue';
import PairView from './components/PairView.vue';
import StatusBar from './components/StatusBar.vue';
import SummaryCards from './components/SummaryCards.vue';
import TradesTable from './components/TradesTable.vue';
import { useStats } from './composables/useStats';

const { stats, offline } = useStats();

// Страница пары — в адресе (#/pair/ZKUSDT): её можно открыть ссылкой и вернуться «назад».
const pair = ref<string | null>(null);
function readHash(): void {
  const m = /^#\/pair\/([A-Z0-9]+)$/.exec(location.hash);
  pair.value = m ? m[1]! : null;
}
function open(symbol: string): void {
  location.hash = `#/pair/${symbol}`;
}
function back(): void {
  location.hash = '';
}
onMounted(() => {
  readHash();
  window.addEventListener('hashchange', readHash);
});
onBeforeUnmount(() => window.removeEventListener('hashchange', readHash));

const multi = computed(() => (stats.value?.symbols.length ?? 0) > 1);
const costs = computed(() => {
  const s = stats.value;
  if (s?.feePct == null || s.slippagePct == null) return '';
  return ` с учётом комиссии ${s.feePct}% и проскальзывания ${s.slippagePct}% за сторону`;
});
</script>

<template>
  <StatusBar :stats="stats" :offline="offline" />
  <main>
    <PairView v-if="pair" :symbol="pair" :bank="stats?.bankRatePct ?? 0" :order-rub="stats?.orderRub ?? 0" @back="back" />
    <template v-else>
      <SummaryCards v-if="stats" :stats="stats" />
      <GroupTable
        :title="multi ? `Стратегии · сумма по ${stats?.symbols.length} парам` : 'Стратегии'"
        :rows="stats?.strategies ?? []"
        kind="strategy"
        :bank="stats?.bankRatePct ?? 0"
      />
      <GroupTable
        v-if="multi"
        :title="`Пары · ${stats?.pairs.length} — нажми, чтобы открыть график и 12 ботов`"
        :rows="stats?.pairs ?? []"
        kind="pair"
        :bank="stats?.bankRatePct ?? 0"
        @open="open"
      />
      <BotsTable
        :bots="stats?.bots ?? []"
        :bank="stats?.bankRatePct ?? 0"
        :show-pair="multi"
        :title="multi ? 'Все боты' : 'Боты'"
        :loading="!stats"
        @open="open"
      />
      <TradesTable :trades="stats?.lastTrades ?? []" :loading="!stats" />
    </template>
  </main>
  <footer>
    Обновление каждые 30 секунд. Тест на реальных ценах Bybit spot{{ costs }}. Реальных ордеров нет.
  </footer>
</template>
