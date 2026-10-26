import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import PairView from '../src/components/PairView.vue';
import SparkLine from '../src/components/SparkLine.vue';
import StatusBar from '../src/components/StatusBar.vue';
import SummaryCards from '../src/components/SummaryCards.vue';
import { fetchStats } from '../src/composables/useStats';
import { apr, pairName, rub, shortName, sparkPoints } from '../src/format';
import { pair, stats } from './fixtures';

const plain = (s: string) => s.replace(/\s/g, ' ');

afterEach(() => {
  vi.unstubAllGlobals();
  location.hash = '';
});

describe('PairView: редкие случаи', () => {
  it('показывает ошибку загрузки и перезагружает пару при смене символа', async () => {
    const fetchFn = vi.fn(async () => new Response('нет', { status: 500 }));
    vi.stubGlobal('fetch', fetchFn);
    const w = mount(PairView, { props: { symbol: 'ZKUSDT', bank: 16, orderRub: 10 } });
    await flushPromises();
    expect(w.text()).toContain('Не удалось загрузить пару: HTTP 500');

    const detail = { symbol: 'TIAUSDT', pair: pair({ name: 'TIAUSDT', price: null, minOrderUsdt: null, aprPct: null, pnlRub: 0 }), bots: [], trades: [] };
    fetchFn.mockImplementation(async () => new Response(JSON.stringify(detail)));
    await w.setProps({ symbol: 'TIAUSDT' });
    await flushPromises();
    expect(w.text()).not.toContain('Не удалось');
    const cards = w.findAll('.card .v').map(c => c.text());
    expect(cards[0]).toBe('—');
    expect(cards[2]).toBe('—');
    expect(cards[3]).toBe('—');
    expect(fetchFn).toHaveBeenLastCalledWith('/api/pair/TIAUSDT', { cache: 'no-store' });
    w.unmount();
  });

  it('пара в минусе и годовые ниже вклада — красным', async () => {
    const detail = { symbol: 'ZKUSDT', pair: pair({ pnlRub: -3, aprPct: 2 }), bots: [], trades: [] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detail))));
    const w = mount(PairView, { props: { symbol: 'ZKUSDT', bank: 16, orderRub: 10 } });
    await flushPromises();
    expect(w.findAll('.card .v.down')).toHaveLength(2);
    await w.get('a').trigger('click');
    expect(w.emitted('back')).toHaveLength(1);
    w.unmount();
  });
});

describe('App: переходы', () => {
  it('открывает пару из таблицы пар и возвращается назад', async () => {
    const detail = { symbol: 'TIAUSDT', pair: stats().pairs[1], bots: [], trades: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).startsWith('/api/pair/') ? detail : stats()))));
    const w = mount(App);
    await flushPromises();
    await w.get('[data-row="TIAUSDT"]').trigger('click');
    expect(location.hash).toBe('#/pair/TIAUSDT');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    await w.get('a').trigger('click');
    expect(location.hash).toBe('');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    expect(w.text()).toContain('Все боты');
    w.unmount();
  });

  it('одна пара без данных об издержках — без таблицы пар и без строки об издержках', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(stats({ symbols: ['ZKUSDT'], feePct: undefined as never })))));
    const w = mount(App);
    await flushPromises();
    expect(w.text()).not.toContain('Пары ·');
    expect(w.text()).not.toContain('с учётом комиссии');
    w.unmount();
  });
});

describe('SparkLine', () => {
  it('падение рисует красным, а одна точка — ничего', () => {
    expect(mount(SparkLine, { props: { values: [3, 1] } }).get('svg').attributes('aria-label')).toBe('снижение');
    expect(mount(SparkLine, { props: { values: [] } }).find('svg').exists()).toBe(false);
  });
});

describe('StatusBar: редкие случаи', () => {
  it('без данных — прочерк, остановленный бот, опрос и пропуски', () => {
    expect(mount(StatusBar, { props: { stats: null, offline: false } }).text()).toContain('—');
    const s = stats({
      status: 'stopped' as never, symbols: ['ZKUSDT'], price: 0.5, updatedAt: '' as never,
      feed: { source: 'опрос', streamConnected: false, lagSec: 3, fetchMs: 100, staleSkips: 2 },
    });
    const w = mount(StatusBar, { props: { stats: s, offline: false } });
    expect(w.text()).toContain('остановлен');
    expect(w.text()).toContain('ZKUSDT · 5м');
    expect(w.get('[data-feed]').text()).toContain('опрос · задержка 3 с');
    expect(w.get('[data-feed]').text()).toContain('пропусков 2');
    expect(mount(StatusBar, { props: { stats: stats({ status: 'stale', ageSec: undefined as never }), offline: false } }).text())
      .toContain('не отвечает 0 мин');
  });
});

describe('SummaryCards: редкие случаи', () => {
  it('без стратегий, без годовых и со ставкой минимальным ордером', () => {
    const base = stats();
    const s = stats({
      strategies: [], orderPct: 0, sessionDays: null,
      totals: { ...base.totals, pnlRub: -2, aprPct: null, winRatePct: null },
    });
    const cards = mount(SummaryCards, { props: { stats: s } }).findAll('.card').map(c => plain(c.text()));
    expect(cards[0]).toContain('−2,00 ₽');
    expect(cards[1]).toContain('считаем после 6 ч');
    expect(cards.find(c => c.startsWith('Лучшая'))).toContain('—');
    expect(cards.find(c => c.startsWith('Авто-выбор'))).toContain('—');
    expect(cards.find(c => c.startsWith('Ставка'))).toContain('мин. ордер');
    expect(cards.find(c => c.startsWith('Сделок'))).not.toContain('удачных');
    expect(cards.find(c => c.startsWith('Наработка'))).toContain('сессия —');

    const zero = stats({ totals: { ...base.totals, pnlRub: 0, aprPct: 30 }, enforceMinOrder: true });
    const z = mount(SummaryCards, { props: { stats: zero } }).findAll('.card').map(c => plain(c.text()));
    expect(z[1]).toContain('лучше вклада');
    expect(z.find(c => c.startsWith('Ставка'))).not.toContain('без минимума');
  });
});

describe('format: редкие случаи', () => {
  it('рубли, годовые, имена и ровная искра', () => {
    expect(plain(rub(-1.5))).toBe('−1,50 ₽');
    expect(plain(rub(0, true))).toBe('±0 ₽');
    expect(plain(rub(-25, true))).toBe('−25 ₽');
    expect(plain(rub(1500))).toBe('1 500 ₽');
    expect(apr(null)).toBe('—');
    expect(pairName('ZKUSDT')).toBe('ZK');
    expect(shortName('(14)')).toBe('(14)');
    expect(sparkPoints([1, 1], 10, 10)).toBe('0.0,8.5 10.0,8.5');
  });

  it('fetchStats сообщает о неудачном ответе', async () => {
    await expect(fetchStats(async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503');
  });
});

describe('App: вкладки', () => {
  it('переключает вкладку и запоминает её в адресе', async () => {
    location.hash = '';
    const w = mount(App);
    await flushPromises();

    await w.get('[data-tab="bots"]').trigger('click');

    expect(location.hash).toBe('#/bots');
    expect(w.get('[data-tab="bots"]').classes()).toContain('active');
    w.unmount();
    location.hash = '';
  });
});

describe('комиссии', () => {
  it('показывает доли от дохода и «съели весь доход», если дохода не было', async () => {
    const { feesText } = await import('../src/format');
    expect(feesText({ feesUsd: 0.5, feesShareOfIncomePct: 40 })).toBe('0,50 $ · 40,0 % дохода');
    expect(feesText({ feesUsd: 1.234, feesShareOfIncomePct: null })).toBe('1,23 $ · съели весь доход');
  });
});

describe('холдеры', () => {
  it('узнаёт холдера по имени стратегии', async () => {
    const { isHolder } = await import('../src/format');
    expect(isHolder('DCA-холдер быстрый (+0.6%→0.6%)')).toBe(true);
    expect(isHolder('RSI (14, 30/70)')).toBe(false);
  });
});
