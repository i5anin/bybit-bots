<script setup lang="ts">
import { money, signed, trend } from '../format';
import type { BotStats } from '../types';
import SparkLine from './SparkLine.vue';

defineProps<{ bots: BotStats[]; baseAsset: string; loading: boolean }>();
</script>

<template>
  <h2>Стратегии</h2>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="rank" />
          <th>Стратегия</th>
          <th class="num">Счёт, ₽</th>
          <th class="num">Счёт, $</th>
          <th class="num">Токены, {{ baseAsset }}</th>
          <th class="num">Доходность</th>
          <th class="num">Сделок</th>
          <th>Позиция</th>
          <th>Динамика</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!bots.length">
          <td colspan="9" class="empty">{{ loading ? 'Загрузка…' : 'Данных пока нет' }}</td>
        </tr>
        <tr v-for="(b, i) in bots" :key="b.name" :data-bot="b.name">
          <td class="rank">{{ i + 1 }}</td>
          <td class="nm">
            {{ b.name }}
            <div v-if="b.isMeta" class="sub">
              {{ b.leader ? `повторяет: ${b.leader}` : 'вне рынка: за сутки в плюсе нет никого' }}
            </div>
          </td>
          <td class="num">{{ money(b.equityRub) }}</td>
          <td class="num">{{ money(b.equity) }}</td>
          <td class="num">
            <template v-if="b.position">{{ money(b.position, 1) }}</template>
            <span v-else class="dim">—</span>
          </td>
          <td class="num" :class="trend(b.pnlPct)">{{ signed(b.pnlPct) }} %</td>
          <td class="num">{{ b.trades }}</td>
          <td><span class="pos" :class="{ in: b.position }">{{ b.position ? 'в рынке' : 'вне рынка' }}</span></td>
          <td><SparkLine :values="b.spark" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
