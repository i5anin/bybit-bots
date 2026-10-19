<script setup lang="ts">
import { computed } from 'vue';
import { price, time } from '../format';
import type { Stats } from '../types';

const props = defineProps<{ stats: Stats | null; offline: boolean }>();

const runText = computed(() => {
  const s = props.stats;
  if (!s) return '—';
  if (s.status === 'running') return `работает, тиков ${s.ticks}`;
  if (s.status === 'stale') return `не отвечает ${Math.round((s.ageSec ?? 0) / 60)} мин`;
  return 'остановлен';
});

// Насколько свежие решения: поток — доли секунды после закрытия свечи,
// опрос — до минуты. Пропуски из-за устаревших данных — красным.
const feedText = computed(() => {
  const f = props.stats?.feed;
  if (!f || f.lagSec === null) return '';
  const src = f.streamConnected ? 'поток' : 'опрос';
  return `${src} · задержка ${f.lagSec} с · биржа ${f.fetchMs} мс${f.staleSkips ? ` · пропусков ${f.staleSkips}` : ''}`;
});

const updated = computed(() => {
  if (props.offline) return 'нет связи с сервером';
  return props.stats?.updatedAt ? `обновлено ${time(props.stats.updatedAt)}` : '';
});
</script>

<template>
  <header>
    <div class="bar">
      <h1>Боты Bybit</h1>
      <span class="dim">{{ !stats ? '—' : stats.symbols.length > 1 ? `${stats.symbols.length} пар · ${stats.totals.bots} ботов · ${stats.interval}м` : `${stats.symbol} · ${stats.interval}м` }}</span>
      <span v-if="stats?.price" class="dim">цена <b style="color: var(--text)">{{ `${price(stats.price)} $` }}</b></span>
      <span class="dim">
        <span class="dot" :class="{ on: stats?.status === 'running', stale: stats?.status === 'stale' }" />{{ runText }}
      </span>
      <span v-if="feedText" class="dim" :class="{ down: stats?.feed?.staleSkips }" data-feed>{{ feedText }}</span>
      <span class="dim" style="margin-left: auto">{{ updated }}</span>
    </div>
  </header>
</template>
