<script setup lang="ts">
import { apr, feesText as fees, isHolder, pairName, price, rub, shortName, trend } from '../format';
import type { GroupStats, PairStats } from '../types';

// Сводная таблица: стратегии (сумма по всем парам) или пары (сумма по стратегиям).
const props = defineProps<{
  title: string;
  rows: (GroupStats | PairStats)[];
  kind: 'strategy' | 'pair';
  bank: number;
}>();
const emit = defineEmits<{ open: [symbol: string] }>();

const isPair = props.kind === 'pair';
const label = (name: string) => (isPair ? pairName(name) : shortName(name));
const bestLabel = (name: string) => (isPair ? shortName(name) : pairName(name));
</script>

<template>
  <h2>{{ title }}</h2>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="rank" />
          <th>{{ isPair ? 'Пара' : 'Стратегия' }}</th>
          <th v-if="isPair" class="num">Цена</th>
          <th class="num">Счёт</th>
          <th class="num">С начала</th>
          <th class="num">Годовых</th>
          <th class="num">В плюсе</th>
          <th class="num">Сделок</th>
          <th class="num">Комиссии</th>
          <th>{{ isPair ? 'Лучшая стратегия' : 'Лучшая пара' }}</th>
          <th v-if="isPair" class="num">Мин. ордер</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!rows.length"><td colspan="11" class="empty">Данных пока нет</td></tr>
        <tr v-for="(g, i) in rows" :key="g.name" :class="{ link: isPair, holder: !isPair && isHolder(g.name) }" :data-row="g.name" @click="isPair && emit('open', g.name)">
          <td class="rank">{{ i + 1 }}</td>
          <td class="nm">{{ label(g.name) }}</td>
          <td v-if="isPair" class="num">{{ (g as PairStats).price === null ? '—' : price((g as PairStats).price!) }}</td>
          <td class="num">{{ rub(g.equityRub) }}</td>
          <td class="num" :class="trend(g.pnlRub)">{{ rub(g.pnlRub, true) }}</td>
          <td class="num" :class="g.aprPct === null ? '' : g.aprPct > bank ? 'up' : 'down'">{{ apr(g.aprPct) }}</td>
          <td class="num">{{ g.inPlus }}/{{ g.bots }}</td>
          <td class="num">{{ g.trades }}</td>
          <td class="num dim">{{ fees(g) }}</td>
          <td class="dim">{{ g.best ? `${bestLabel(g.best.name)} ${rub(g.best.pnlRub, true)}` : '—' }}</td>
          <td v-if="isPair" class="num dim">{{ (g as PairStats).minOrderUsdt === null ? '—' : `${(g as PairStats).minOrderUsdt} $` }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
