// Дочитывание растущих CSV-логов. equity.csv прибавляет ~1.4 МБ в сутки, и
// разбирать его целиком на каждый запрос панели (раз в 30 с) — лишняя работа:
// помним, сколько байт уже прочитано, и разбираем только прибавившееся.
import { open, stat } from 'node:fs/promises';

const NL = 0x0a;

// Разбор строки CSV с кавычками по RFC 4180: «""» внутри кавычек — это «"».
export function splitRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i += 1; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
  if (lines.length < 2) return [];
  const head = splitRow(lines[0]);
  return lines.slice(1).map(line => toRow(head, line));
}

function toRow(head, line) {
  const cells = splitRow(line);
  return Object.fromEntries(head.map((k, i) => [k, cells[i] ?? '']));
}

// Читатель хвоста файла. onRows получает новые строки; onReset — сигнал, что
// файл начат заново (стал короче: статистику сбросили) и накопленное надо забыть.
// Вызовы выстроены в очередь: два параллельных запроса панели не прочитают
// один и тот же кусок дважды.
export function createCsvTail(path, { onRows, onReset }) {
  let offset = 0;
  let head = null;
  let rest = Buffer.alloc(0); // незаконченная строка: бот мог дописывать её в момент чтения
  let queue = Promise.resolve();

  async function readNew() {
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      size = 0; // файла нет — бот ещё не отработал ни одного тика
    }
    if (size < offset) {
      offset = 0;
      head = null;
      rest = Buffer.alloc(0);
      onReset?.();
    }
    if (size === offset) return;

    const fh = await open(path, 'r');
    let chunk;
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
    rest = data.subarray(cut + 1);
    const lines = data.subarray(0, cut).toString('utf8').split('\n')
      .map(l => l.replace(/\r$/, '')).filter(Boolean);
    if (!head && lines.length) head = splitRow(lines.shift());
    if (lines.length) onRows(lines.map(line => toRow(head, line)));
  }

  return function read() {
    queue = queue.then(readNew, readNew);
    return queue;
  };
}

// Ряд значений с равномерным прореживанием по всей истории: когда точек
// становится вдвое больше лимита, оставляем каждую вторую и вдвое реже
// записываем новые. Память ограничена, а форма кривой за весь срок сохраняется.
export class DecimatedSeries {
  constructor(limit = 1000) {
    this.limit = limit;
    this.values = [];
    this.stride = 1;
    this.count = 0;
    this.last = null;
  }

  push(value) {
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
  sample(points) {
    if (!this.values.length) return [];
    const step = Math.max(1, Math.ceil(this.values.length / points));
    const out = this.values.filter((_, i) => i % step === 0).slice(-(points - 1));
    out.push(this.last);
    return out;
  }
}
