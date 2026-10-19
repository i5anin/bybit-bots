import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import App from '../src/App.vue';
import BotsTable from '../src/components/BotsTable.vue';
import GroupTable from '../src/components/GroupTable.vue';
import StatusBar from '../src/components/StatusBar.vue';
import SummaryCards from '../src/components/SummaryCards.vue';
import TradesTable from '../src/components/TradesTable.vue';
import { useStats } from '../src/composables/useStats';
import { bot, stats } from './fixtures';

const plain = (s: string) => s.replace(/\s/g, ' ');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  location.hash = '';
});

describe('BotsTable', () => {
  it('lists every bot with its pair, result and annual return against the deposit', () => {
    const w = mount(BotsTable, { props: { bots: stats().bots, bank: 16 } });
    const row = w.get('[data-bot="ZKUSDT:Stochastic Oscillator (14, 20/80)"]');
    expect(row.text()).toContain('ZK');
    expect(row.text()).toContain('Stochastic Oscillator');
    expect(plain(row.text())).toContain('+6,25 ₽');
    expect(row.findAll('td.up').length).toBeGreaterThan(0);
    expect(w.get('[data-bot="TIAUSDT:MACD (12/26/9)"]').findAll('td.down').length).toBeGreaterThan(0);
  });

  it('shows 100 of 1200 bots and finds any of them by pair or strategy', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => bot({ symbol: `P${i % 100}USDT`, name: `S${Math.floor(i / 100)}`, key: `k${i}` }));
    const w = mount(BotsTable, { props: { bots: many, bank: 16 } });
    expect(w.findAll('tbody tr')).toHaveLength(100);
    await w.get('button').trigger('click');
    expect(w.findAll('tbody tr')).toHaveLength(1200);
    await w.get('input').setValue('p7usdt');
    expect(w.findAll('tbody tr')).toHaveLength(12);
  });

  it('opens the pair page from a bot row', async () => {
    const w = mount(BotsTable, { props: { bots: stats().bots, bank: 16 } });
    await w.get('a.pair').trigger('click');
    expect(w.emitted('open')?.[0]).toEqual(['ZKUSDT']);
  });

  it('renders a strategy name as text, never as markup', () => {
    const w = mount(BotsTable, { props: { bots: [bot({ name: '<img src=x onerror=alert(1)>' })], bank: 16 } });
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('on a pair page shows who the meta bot follows and the sparkline', () => {
    const w = mount(BotsTable, { props: { bots: stats().bots, bank: 16, showPair: false } });
    expect(w.text()).toContain('повторяет: Stochastic Oscillator');
    expect(w.findAll('polyline').length).toBeGreaterThan(0);
  });
});

describe('GroupTable', () => {
  it('ranks pairs and opens one on click', async () => {
    const w = mount(GroupTable, { props: { title: 'Пары', rows: stats().pairs, kind: 'pair', bank: 16 } });
    expect(w.text()).toContain('5 $');
    await w.get('[data-row="TIAUSDT"]').trigger('click');
    expect(w.emitted('open')?.[0]).toEqual(['TIAUSDT']);
  });

  it('strategy rows are not links and show the best pair', () => {
    const w = mount(GroupTable, { props: { title: 'Стратегии', rows: stats().strategies, kind: 'strategy', bank: 16 } });
    expect(w.text()).toContain('ZK +6,25 ₽'.replace(' ', ' ').replace(/ /, ' '));
    expect(w.find('tr.link').exists()).toBe(false);
  });
});

describe('SummaryCards', () => {
  it('compares the annual return with the deposit and shows the stake', () => {
    const cards = mount(SummaryCards, { props: { stats: stats() } }).findAll('.card').map(c => plain(c.text()));
    expect(cards[0]).toContain('Все 3 ботов');
    expect(cards[1]).toContain('+13.1 %');
    expect(cards[1]).toContain('вклад 16 % · хуже вклада');
    expect(cards[2]).toContain('1 / 3');
    expect(cards.find(c => c.startsWith('Ставка'))).toContain('1 % · 10 ₽');
  });
});

describe('TradesTable', () => {
  it('adds the pair column when trades span several pairs', () => {
    const w = mount(TradesTable, { props: { trades: stats().lastTrades, loading: false } });
    expect(w.text()).toContain('Пара');
    const rows = w.findAll('tbody tr').map(r => r.text());
    expect(rows[0]).toContain('TIA');
    expect(rows[1]).toContain('вход');
  });
});

describe('StatusBar', () => {
  it('names the number of pairs and bots', () => {
    const w = mount(StatusBar, { props: { stats: stats(), offline: false } });
    expect(w.text()).toContain('2 пар · 3 ботов · 5м');
    expect(w.get('[data-feed]').text()).toBe('поток · задержка 0.4 с · биржа 180 мс');
  });

  it('reports a hung bot and a lost connection', () => {
    expect(mount(StatusBar, { props: { stats: stats({ status: 'stale', running: false, ageSec: 900 }), offline: false } }).text())
      .toContain('не отвечает 15 мин');
    expect(mount(StatusBar, { props: { stats: stats(), offline: true } }).text()).toContain('нет связи с сервером');
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
    expect(api.stats.value?.symbol).toBe('ZKUSDT');
    ok = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.offline.value).toBe(true);
    expect(api.stats.value?.symbol).toBe('ZKUSDT');
  });
});

describe('App', () => {
  it('shows strategies, pairs and all bots, and opens a pair page', async () => {
    const pairDetail = { symbol: 'ZKUSDT', pair: stats().pairs[0], bots: stats().bots.filter(b => b.symbol === 'ZKUSDT'), trades: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).startsWith('/api/pair/') ? pairDetail : stats()))));
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('Стратегии · сумма по 2 парам');
    expect(w.text()).toContain('Пары · 2');
    expect(w.text()).toContain('Все боты · 3');
    location.hash = '#/pair/ZKUSDT';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    expect(w.text()).toContain('← все пары');
    expect(w.get('img.chart').attributes('src')).toMatch(/^\/api\/pair\/ZKUSDT\/chart\.png\?t=\d+$/);
    expect(w.text()).toContain('Боты ZK · 2');
    w.unmount();
  });
});
