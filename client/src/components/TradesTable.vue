<script setup lang="ts">
import { computed } from 'vue';
import { dateTime, price, signed, trend } from '../format';
import type { TradeRow } from '../types';

const props = defineProps<{ trades: TradeRow[]; loading: boolean }>();

// Пустой pnlPct — вход в позицию, у него ещё нет результата.
const rows = computed(() => props.trades.filter(t => t.time).map(t => ({
  key: `${t.time}|${t.bot}|${t.side}`,
  when: dateTime(t.time),
  bot: t.bot,
  side: t.side === 'buy' ? 'покупка' : 'продажа',
  price: price(Number(t.price)),
  pnl: t.pnlPct === '' ? null : Number(t.pnlPct),
})));
</script>

<template>
  <h2>Последние сделки</h2>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>Время</th>
          <th>Стратегия</th>
          <th>Направление</th>
          <th class="num">Цена</th>
          <th class="num">Результат</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!rows.length">
          <td colspan="5" class="empty">{{ loading ? 'Загрузка…' : 'Сделок пока нет' }}</td>
        </tr>
        <tr v-for="r in rows" :key="r.key">
          <td class="dim">{{ r.when }}</td>
          <td>{{ r.bot }}</td>
          <td>{{ r.side }}</td>
          <td class="num">{{ r.price }}</td>
          <td class="num" :class="r.pnl === null ? '' : trend(r.pnl)">
            <span v-if="r.pnl === null" class="dim">вход</span>
            <template v-else>{{ signed(r.pnl) }} %</template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
