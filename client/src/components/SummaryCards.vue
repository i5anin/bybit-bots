<script setup lang="ts">
import { computed } from 'vue';
import { apr, fixed, hours, money, rub, shortName } from '../format';
import type { Stats } from '../types';

const props = defineProps<{ stats: Stats }>();

interface Card {
  title: string;
  value: string;
  sub: string;
  tone?: 'up' | 'down' | '';
}

// Главное — обгоняют ли боты вклад: торговать имеет смысл, только если да.
const cards = computed<Card[]>(() => {
  const s = props.stats;
  const t = s.totals;
  const tone = (v: number | null) => (v === null ? '' : v > s.bankRatePct ? 'up' : 'down');
  const meta = s.strategies.find(g => g.isMeta);
  const best = s.strategies.find(g => !g.isMeta);
  return [
    {
      title: `Все ${t.bots} ботов`,
      value: rub(t.pnlRub, true),
      sub: `${rub(t.equityRub)} из ${rub(t.investedRub)}`,
      tone: t.pnlRub > 0 ? 'up' : t.pnlRub < 0 ? 'down' : '',
    },
    {
      title: 'Годовых',
      value: apr(t.aprPct),
      sub: `вклад ${s.bankRatePct} % · ${t.aprPct === null ? 'считаем после 6 ч' : t.aprPct > s.bankRatePct ? 'лучше вклада' : 'хуже вклада'}`,
      tone: tone(t.aprPct),
    },
    { title: 'Обгоняют вклад', value: `${t.beatsBank} / ${t.bots}`, sub: `в плюсе ${t.inPlus}, в рынке ${t.inMarket}` },
    best
      ? { title: 'Лучшая стратегия', value: shortName(best.name), sub: `${rub(best.pnlRub, true)} · ${apr(best.aprPct)} годовых`, tone: tone(best.aprPct) }
      : { title: 'Лучшая стратегия', value: '—', sub: '' },
    meta
      ? { title: 'Авто-выбор', value: rub(meta.pnlRub, true), sub: `${apr(meta.aprPct)} годовых · ${meta.bots} пар`, tone: tone(meta.aprPct) }
      : { title: 'Авто-выбор', value: '—', sub: '' },
    {
      title: 'Ставка',
      value: s.orderPct ? `${s.orderPct} % · ${rub(s.orderRub)}` : 'мин. ордер',
      sub: `старт ${rub(s.startRub)} на бота${s.orderPct && !s.enforceMinOrder ? ' · без минимума биржи' : ''}`,
    },
    { title: 'Сделок', value: money(t.tradesTotal, 0), sub: `закрыто ${t.tradesClosed}${t.winRatePct === null ? '' : ` · удачных ${fixed(t.winRatePct, 1)} %`}` },
    { title: 'Наработка', value: hours(s.uptimeSecTotal), sub: `сессия ${s.sessionDays === null ? '—' : `${fixed(s.sessionDays, 1)} дн`} · запусков ${s.runs}` },
  ];
});
</script>

<template>
  <div class="cards">
    <div v-for="card in cards" :key="card.title" class="card">
      <div class="k">{{ card.title }}</div>
      <div class="v" :class="card.tone">{{ card.value }}</div>
      <div class="k">{{ card.sub }}</div>
    </div>
  </div>
</template>
