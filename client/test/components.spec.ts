import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import App from '../src/App.vue';
import BotsTable from '../src/components/BotsTable.vue';
import StatusBar from '../src/components/StatusBar.vue';
import SummaryCards from '../src/components/SummaryCards.vue';
import TradesTable from '../src/components/TradesTable.vue';
import { useStats } from '../src/composables/useStats';
import { bot, stats } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BotsTable', () => {
  it('shows who the meta bot follows', () => {
    const w = mount(BotsTable, { props: { bots: stats().bots, baseAsset: 'DOGE', loading: false } });
    const meta = w.get('[data-bot="Авто-выбор лучшей (11)"]');
    expect(meta.text()).toContain('повторяет: Donchian Breakout (20)');
    expect(w.text()).toContain('Токены, DOGE');
  });

  it('explains why the meta bot is out of the market', () => {
    const bots = [bot({ name: 'Авто', isMeta: true, leader: null, position: 0 })];
    const w = mount(BotsTable, { props: { bots, baseAsset: 'DOGE', loading: false } });
    expect(w.text()).toContain('вне рынка: за сутки в плюсе нет никого');
  });

  it('renders a strategy name as text, never as markup', () => {
    const bots = [bot({ name: '<img src=x onerror=alert(1)>' })];
    const w = mount(BotsTable, { props: { bots, baseAsset: 'DOGE', loading: false } });
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('marks gains and losses and draws a sparkline', () => {
    const w = mount(BotsTable, { props: { bots: [bot(), bot({ name: 'loss', pnlPct: -2 })], baseAsset: 'DOGE', loading: false } });
    expect(w.findAll('td.up')).toHaveLength(1);
    expect(w.findAll('td.down')).toHaveLength(1);
    expect(w.findAll('polyline')).toHaveLength(2);
  });

  it('says loading before the first answer', () => {
    const w = mount(BotsTable, { props: { bots: [], baseAsset: '', loading: true } });
    expect(w.text()).toContain('Загрузка…');
  });
});

describe('SummaryCards', () => {
  it('counts every account from the fixed ruble start', () => {
    const w = mount(SummaryCards, { props: { stats: stats() } });
    // ru-RU разделяет тысячи узким неразрывным пробелом — сводим к обычному.
    const cards = w.findAll('.card').map(c => c.text().replace(/\s/g, ' '));
    expect(cards[0]).toMatch(/^Авто-выбор/);
    expect(cards[0]).toContain('из 1 000 ₽');
    expect(cards[1]).toMatch(/^Лучшая стратегия/);
    expect(cards[1]).toContain('+6.25 % в ₽');
    expect(cards[1]).toContain('+4.35 % в $');
    expect(w.text()).toContain('28.5 %');
  });
});

describe('TradesTable', () => {
  it('shows entries without a result and exits with one', () => {
    const w = mount(TradesTable, { props: { trades: stats().lastTrades, loading: false } });
    const rows = w.findAll('tbody tr').map(r => r.text());
    expect(rows[0]).toContain('продажа');
    expect(rows[0]).toContain('-0.31 %');
    expect(rows[1]).toContain('покупка');
    expect(rows[1]).toContain('вход');
  });
});

describe('StatusBar', () => {
  it('reports a hung bot instead of calling it running', () => {
    const w = mount(StatusBar, { props: { stats: stats({ status: 'stale', running: false, ageSec: 900 }), offline: false } });
    expect(w.text()).toContain('не отвечает 15 мин');
    expect(w.get('.dot').classes()).toContain('stale');
  });

  it('shows where the data comes from and how fresh it is', () => {
    const w = mount(StatusBar, { props: { stats: stats(), offline: false } });
    expect(w.get('[data-feed]').text()).toBe('поток · задержка 0.4 с · биржа 180 мс');
    const stale = mount(StatusBar, { props: { stats: stats({ feed: { source: 'опрос', streamConnected: false, lagSec: 400, fetchMs: 200, staleSkips: 3 } }), offline: false } });
    expect(stale.get('[data-feed]').text()).toContain('опрос');
    expect(stale.get('[data-feed]').classes()).toContain('down');
  });

  it('warns when the server is unreachable', () => {
    const w = mount(StatusBar, { props: { stats: stats(), offline: true } });
    expect(w.text()).toContain('нет связи с сервером');
  });
});

describe('useStats', () => {
  it('keeps the last data on screen when the connection drops', async () => {
    vi.useFakeTimers();
    let ok = true;
    const fetchFn = vi.fn(async () => {
      if (!ok) throw new Error('offline');
      return new Response(JSON.stringify(stats()));
    }) as unknown as typeof fetch;

    let api!: ReturnType<typeof useStats>;
    mount(defineComponent({ setup() { api = useStats(fetchFn, 1000); return () => h('div'); } }));
    await flushPromises();
    expect(api.stats.value?.symbol).toBe('DOGEUSDT');

    ok = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.offline.value).toBe(true);
    expect(api.stats.value?.symbol).toBe('DOGEUSDT');
  });
});

describe('App', () => {
  it('loads stats and shows the costs taken from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(stats()))));
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('работает, тиков 819');
    expect(w.text()).toContain('комиссии 0.1% и проскальзывания 0.02%');
    expect(w.findAll('tbody tr').length).toBeGreaterThan(2);
    w.unmount();
  });
});
