<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { apr, pairName, price, rub } from '../format';
import type { PairDetail } from '../types';
import BotsTable from './BotsTable.vue';
import TradesTable from './TradesTable.vue';

// Страница пары: график цены с входами и выходами её ботов и отчёт по каждому из 12.
const props = defineProps<{ symbol: string; bank: number; orderRub: number }>();
const emit = defineEmits<{ back: [] }>();

const detail = ref<PairDetail | null>(null);
const error = ref('');
const stamp = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  try {
    const res = await fetch(`/api/pair/${props.symbol}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    detail.value = (await res.json()) as PairDetail;
    stamp.value = Date.now();
    error.value = '';
  } catch (err) {
    error.value = `Не удалось загрузить пару: ${(err as Error).message}`;
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 60_000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(() => props.symbol, () => { detail.value = null; void load(); });
</script>

<template>
  <p><a href="#" @click.prevent="emit('back')">← все пары</a></p>
  <h2>{{ pairName(symbol) }}</h2>
  <p v-if="error" class="down">{{ error }}</p>
  <template v-if="detail?.pair">
    <div class="cards">
      <div class="card"><div class="k">Цена</div><div class="v">{{ detail.pair.price === null ? '—' : `${price(detail.pair.price)} $` }}</div></div>
      <div class="card">
        <div class="k">12 ботов пары</div>
        <div class="v" :class="detail.pair.pnlRub > 0 ? 'up' : detail.pair.pnlRub < 0 ? 'down' : ''">{{ rub(detail.pair.pnlRub, true) }}</div>
        <div class="k">{{ rub(detail.pair.equityRub) }} из {{ rub(detail.pair.investedRub) }}</div>
      </div>
      <div class="card">
        <div class="k">Годовых</div>
        <div class="v" :class="detail.pair.aprPct === null ? '' : detail.pair.aprPct > bank ? 'up' : 'down'">{{ apr(detail.pair.aprPct) }}</div>
        <div class="k">вклад {{ bank }} %</div>
      </div>
      <div class="card">
        <div class="k">Минимальный ордер биржи</div>
        <div class="v">{{ detail.pair.minOrderUsdt === null ? '—' : `${detail.pair.minOrderUsdt} $` }}</div>
        <div class="k">ставка в тесте {{ rub(orderRub) }}</div>
      </div>
    </div>
  </template>
  <img
    class="chart"
    :src="`/api/pair/${symbol}/chart.png?t=${stamp}`"
    :alt="`График ${pairName(symbol)}: цена за сутки, входы и выходы ботов, заработок каждого`"
  />
  <BotsTable :bots="detail?.bots ?? []" :bank="bank" :show-pair="false" :title="`Боты ${pairName(symbol)}`" :loading="!detail" />
  <TradesTable :trades="detail?.trades ?? []" :loading="!detail" />
</template>
