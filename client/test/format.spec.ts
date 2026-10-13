import { describe, expect, it } from 'vitest';
import { hours, money, price, signed, sparkPoints, trend } from '../src/format';

describe('format', () => {
  it('formats money in the Russian locale', () => {
    expect(money(1062.5).replace(/\s/g, ' ')).toBe('1 062,50');
    expect(money(53.5, 1)).toBe('53,5');
  });

  it('adds a plus sign only to positive values', () => {
    expect(signed(4.351)).toBe('+4.35');
    expect(signed(-1.2)).toBe('-1.20');
    expect(signed(0)).toBe('0.00');
  });

  it('picks price precision by magnitude', () => {
    expect(price(0.084541)).toBe('0.08454');
    expect(price(12.3456)).toBe('12.346');
    expect(price(88486.44)).toBe('88486.4');
  });

  it('classifies the trend', () => {
    expect(trend(1)).toBe('up');
    expect(trend(-1)).toBe('down');
    expect(trend(0)).toBe('');
  });

  it('formats uptime in hours and minutes', () => {
    expect(hours(748_018)).toBe('207 ч 46 м');
    expect(hours(125)).toBe('2 м');
  });

  it('draws a sparkline only from two points and keeps it inside the box', () => {
    expect(sparkPoints([1], 100, 20)).toBeNull();
    const pts = sparkPoints([1, 3, 2], 100, 20)!.split(' ').map(p => p.split(',').map(Number));
    expect(pts).toHaveLength(3);
    expect(pts[0]![0]).toBe(0);
    expect(pts[2]![0]).toBe(100);
    for (const [, y] of pts) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(20);
    }
  });
});
