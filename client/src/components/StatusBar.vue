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

const updated = computed(() => {
  if (props.offline) return 'нет связи с сервером';
  return props.stats?.updatedAt ? `обновлено ${time(props.stats.updatedAt)}` : '';
});
</script>

<template>
  <header>
    <div class="bar">
      <h1>Боты Bybit</h1>
      <span class="dim">{{ stats ? `${stats.symbol} · ${stats.interval}м` : '—' }}</span>
      <span class="dim">цена <b style="color: var(--text)">{{ stats?.price ? `${price(stats.price)} $` : '—' }}</b></span>
      <span class="dim">
        <span class="dot" :class="{ on: stats?.status === 'running', stale: stats?.status === 'stale' }" />{{ runText }}
      </span>
      <span class="dim" style="margin-left: auto">{{ updated }}</span>
    </div>
  </header>
</template>
