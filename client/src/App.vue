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

// Вкладки главной страницы. Выбранная — в адресе (#/bots), чтобы пережить
// обновление страницы; пустой адрес — первая вкладка.
const TABS = [
  { id: 'strategies', label: 'Стратегии' },
  { id: 'pairs', label: 'Пары' },
  { id: 'bots', label: 'Боты' },
  { id: 'trades', label: 'Сделки' },
] as const;
type TabId = typeof TABS[number]['id'];
const tab = ref<TabId>('strategies');

// Страница пары — в адресе (#/pair/ZKUSDT): её можно открыть ссылкой и вернуться «назад».
const pair = ref<string | null>(null);
function readHash(): void {
  const m = /^#\/pair\/([A-Z0-9]+)$/.exec(location.hash);
  pair.value = m ? m[1]! : null;
  const t = TABS.find(x => location.hash === `#/${x.id}`);
  if (t) tab.value = t.id;
}
function selectTab(id: TabId): void {
  tab.value = id;
  location.hash = `#/${id}`;
}
function open(symbol: string): void {
  location.hash = `#/pair/${symbol}`;
}
function back(): void {
  location.hash = tab.value === 'strategies' ? '' : `#/${tab.value}`;
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
      <nav class="tabs">
        <button
          v-for="t in TABS"
          v-show="t.id !== 'pairs' || multi"
          :key="t.id"
          :class="{ active: tab === t.id }"
          :data-tab="t.id"
          @click="selectTab(t.id)"
        >{{ t.label }}</button>
      </nav>
      <!-- v-show, а не v-if: таблицы не пересоздаются при каждом переключении. -->
      <GroupTable
        v-show="tab === 'strategies'"
        :title="multi ? `Стратегии · сумма по ${stats?.symbols.length} парам` : 'Стратегии'"
        :rows="stats?.strategies ?? []"
        kind="strategy"
        :bank="stats?.bankRatePct ?? 0"
      />
      <GroupTable
        v-if="multi"
        v-show="tab === 'pairs'"
        :title="`Пары · ${stats?.pairs.length} — нажми, чтобы открыть график и ботов пары`"
        :rows="stats?.pairs ?? []"
        kind="pair"
        :bank="stats?.bankRatePct ?? 0"
        @open="open"
      />
      <BotsTable
        v-show="tab === 'bots'"
        :bots="stats?.bots ?? []"
        :bank="stats?.bankRatePct ?? 0"
        :show-pair="multi"
        :title="multi ? 'Все боты' : 'Боты'"
        :loading="!stats"
        @open="open"
      />
      <TradesTable v-show="tab === 'trades'" :trades="stats?.lastTrades ?? []" :loading="!stats" />
    </template>
  </main>
  <footer>
    Обновление каждые 30 секунд. Тест на реальных ценах Bybit spot{{ costs }}. Реальных ордеров нет.
  </footer>
</template>
