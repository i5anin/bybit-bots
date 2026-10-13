import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import type { Stats } from '../types';

export const REFRESH_MS = 30_000;

export async function fetchStats(fetchFn: typeof fetch = fetch): Promise<Stats> {
  const res = await fetchFn('/api/stats', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Stats;
}

// Статистика с сервера, обновляется каждые 30 секунд. При сбое связи прежние
// данные остаются на экране, а offline сообщает, что они могли устареть.
export function useStats(fetchFn: typeof fetch = fetch, intervalMs = REFRESH_MS): {
  stats: Ref<Stats | null>;
  offline: Ref<boolean>;
  refresh: () => Promise<void>;
} {
  const stats = ref<Stats | null>(null);
  const offline = ref(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      stats.value = await fetchStats(fetchFn);
      offline.value = false;
    } catch {
      offline.value = true;
    }
  }

  onMounted(() => {
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
  });
  onBeforeUnmount(() => clearInterval(timer));

  return { stats, offline, refresh };
}
