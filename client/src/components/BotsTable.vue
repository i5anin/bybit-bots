<script setup lang="ts">
import { computed, ref } from 'vue';
import { apr, isHolder, money, pairName, rub, shortName, trend } from '../format';
import type { BotStats } from '../types';
import SparkLine from './SparkLine.vue';

// Все боты (пара × стратегия) — 1200 строк, поэтому с поиском и показом по 100.
const props = withDefaults(defineProps<{
  bots: BotStats[];
  bank: number;
  title?: string;
  showPair?: boolean;
  limit?: number;
  loading?: boolean;
}>(), { title: 'Все боты', showPair: true, limit: 100, loading: false });
const emit = defineEmits<{ open: [symbol: string] }>();

const query = ref('');
const showAll = ref(false);
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? props.bots.filter(b => `${b.symbol} ${b.name}`.toLowerCase().includes(q)) : props.bots;
});
const shown = computed(() => (showAll.value ? filtered.value : filtered.value.slice(0, props.limit)));
</script>

<template>
  <h2>{{ title }} · {{ bots.length }}</h2>
  <div v-if="bots.length > limit" class="tools">
    <input v-model="query" type="search" placeholder="Пара или стратегия: ZK, RSI…" aria-label="Поиск бота" />
    <button v-if="filtered.length > limit" type="button" @click="showAll = !showAll">
      {{ showAll ? `Первые ${limit}` : `Показать все ${filtered.length}` }}
    </button>
  </div>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="rank" />
          <th v-if="showPair">Пара</th>
          <th>Стратегия</th>
          <th class="num">Счёт</th>
          <th class="num">С начала</th>
          <th class="num">Годовых</th>
          <th class="num">Сделок</th>
          <th>Позиция</th>
          <th v-if="!showPair">Динамика</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!shown.length"><td colspan="9" class="empty">{{ loading ? 'Загрузка…' : 'Ботов не найдено' }}</td></tr>
        <tr v-for="(b, i) in shown" :key="b.key" :class="{ holder: isHolder(b.name) }" :data-bot="b.key">
          <td class="rank">{{ i + 1 }}</td>
          <td v-if="showPair"><a href="#" class="pair" @click.prevent="emit('open', b.symbol)">{{ pairName(b.symbol) }}</a></td>
          <td class="nm">
            {{ shortName(b.name) }}
            <div v-if="b.isMeta && !showPair" class="sub">
              {{ b.leader ? `повторяет: ${shortName(b.leader)}` : 'вне рынка: за сутки в плюсе нет никого' }}
            </div>
          </td>
          <td class="num">{{ rub(b.equityRub) }}</td>
          <td class="num" :class="trend(b.pnlRub)">{{ rub(b.pnlRub, true) }}</td>
          <td class="num" :class="b.aprPct === null ? '' : b.aprPct > bank ? 'up' : 'down'">{{ apr(b.aprPct) }}</td>
          <td class="num">{{ money(b.trades, 0) }}</td>
          <td><span class="pos" :class="{ in: b.position }">{{ b.position ? 'в рынке' : 'вне рынка' }}</span></td>
          <td v-if="!showPair"><SparkLine :values="b.spark" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
