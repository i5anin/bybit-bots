// Дочитывание растущих CSV-логов. equity.csv прибавляет ~1.4 МБ в сутки, и
// разбирать его целиком на каждый запрос панели — лишняя работа: помним,
// сколько байт уже прочитано, и разбираем только прибавившееся.
import { open, stat } from 'node:fs/promises';
import { parseCsvLine, toRecord, type CsvRecord } from './csv.js';

const NL = 0x0a;

export interface CsvTailHandlers {
  onRows: (rows: CsvRecord[]) => void;
  // Файл начат заново (стал короче: статистику сбросили) — накопленное забыть.
  onReset?: () => void;
}

// Вызовы выстроены в очередь: два параллельных запроса не прочитают один кусок дважды.
export function createCsvTail(path: string, { onRows, onReset }: CsvTailHandlers): () => Promise<void> {
  let offset = 0;
  let head: string[] | null = null;
  let rest = Buffer.alloc(0); // незаконченная строка: её могли дописывать в момент чтения
  let queue: Promise<void> = Promise.resolve();

  async function readNew(): Promise<void> {
    const size = await stat(path).then(info => info.size, () => 0);
    if (size < offset) {
      offset = 0;
      head = null;
      rest = Buffer.alloc(0);
      onReset?.();
    }
    if (size === offset) return;

    const fh = await open(path, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - offset);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    offset += chunk.length;

    // Режем по последнему переводу строки в байтах: так многобайтовая буква
    // в имени стратегии не разрывается на границе чтения.
    const data = Buffer.concat([rest, chunk]);
    const cut = data.lastIndexOf(NL);
    if (cut === -1) {
      rest = data;
      return;
    }
    rest = Buffer.from(data.subarray(cut + 1));
    const lines = data.subarray(0, cut).toString('utf8').split('\n')
      .map(l => l.replace(/\r$/, '')).filter(Boolean);
    if (!head) {
      const first = lines.shift();
      if (first === undefined) return;
      head = parseCsvLine(first);
    }
    const columns = head;
    if (lines.length) onRows(lines.map(line => toRecord(columns, line)));
  }

  return () => {
    queue = queue.then(readNew, readNew);
    return queue;
  };
}

// Ряд значений с равномерным прореживанием по всей истории: когда точек
// становится вдвое больше лимита, оставляем каждую вторую и вдвое реже
// записываем новые. Память ограничена, а форма кривой за весь срок сохраняется.
export class DecimatedSeries {
  values: number[] = [];
  stride = 1;
  private count = 0;
  private last: number | null = null;

  constructor(private readonly limit = 1000) {}

  push(value: number): void {
    this.last = value;
    if (this.count % this.stride === 0) {
      this.values.push(value);
      if (this.values.length > this.limit * 2) {
        this.values = this.values.filter((_, i) => i % 2 === 0);
        this.stride *= 2;
      }
    }
    this.count += 1;
  }

  // points значений для графика-искры; последняя точка — всегда текущее значение.
  sample(points: number): number[] {
    if (!this.values.length || this.last === null) return [];
    const step = Math.max(1, Math.ceil(this.values.length / points));
    const out = this.values.filter((_, i) => i % step === 0).slice(-(points - 1));
    out.push(this.last);
    return out;
  }
}
