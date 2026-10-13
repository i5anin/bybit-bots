<script setup lang="ts">
import { computed } from 'vue';
import { fixed, hours, money, signed } from '../format';
import type { BotStats, Stats } from '../types';

const props = defineProps<{ stats: Stats }>();

interface Card {
  title: string;
  value: string;
  sub: string;
}

// Каждый бот торгует своими деньгами с одного старта, поэтому карточки
// показывают счёт одного бота, а не сумму по всем. Старт в рублях фиксирован
// (START_RUB), а не пересчитан по сегодняшнему курсу.
function account(title: string, b: BotStats | undefined, s: Stats): Card {
  if (!b) return { title, value: '—', sub: '' };
  return {
    title,
    value: `${money(b.equityRub)} ₽`,
    sub: `${signed(b.pnlRubPct)} % в ₽ · ${signed(b.pnlPct)} % в $ · $${money(b.equity)}`
      + ` · ${money(b.position, 1)} ${s.baseAsset} · из ${money(s.startRub, 0)} ₽`,
  };
}

const cards = computed<Card[]>(() => {
  const s = props.stats;
  const t = s.totals;
  const n = s.bots.length || 1;
  const avg = s.bots.reduce((a, b) => a + b.equityRub, 0) / n;
  const avgPct = s.bots.reduce((a, b) => a + b.pnlRubPct, 0) / n;
  return [
    account('Авто-выбор', s.bots.find(b => b.isMeta), s),
    account('Лучшая стратегия', s.bots.find(b => !b.isMeta), s),
    {
      title: 'В среднем на бота',
      value: `${money(avg)} ₽`,
      sub: `${signed(avgPct)} % в ₽ · из ${money(s.startRub, 0)} ₽ · курс ${fixed(s.rubPerUsd)} (${s.rateSource})`,
    },
    { title: 'Стратегий в плюсе', value: `${t.inProfit} / ${s.bots.length}`, sub: '' },
    { title: 'Сделок', value: String(t.tradesTotal), sub: `закрыто ${t.tradesClosed}` },
    { title: 'Доля удачных', value: t.winRatePct === null ? '—' : `${fixed(t.winRatePct, 1)} %`, sub: '' },
    { title: 'Наработка', value: hours(s.uptimeSecTotal), sub: `запусков ${s.runs}` },
  ];
});
</script>

<template>
  <div class="cards">
    <div v-for="card in cards" :key="card.title" class="card">
      <div class="k">{{ card.title }}</div>
      <div class="v">{{ card.value }}</div>
      <div class="k">{{ card.sub }}</div>
    </div>
  </div>
</template>
