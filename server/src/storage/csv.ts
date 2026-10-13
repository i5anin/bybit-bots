// CSV по RFC 4180: имена стратегий содержат запятые («RSI (14, 30/70)»)
// и без кавычек ломают любой парсер.
const NEEDS_QUOTES = /["\n\r,]/;

export type CsvValue = string | number | null | undefined;

export function csvField(value: CsvValue): string {
  const text = value === null || value === undefined ? '' : String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvField).join(',') + '\n';
}

// Разбор строки с кавычками: «""» внутри кавычек — это «"».
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
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

export type CsvRecord = Record<string, string>;

export function toRecord(head: readonly string[], line: string): CsvRecord {
  const cells = parseCsvLine(line);
  return Object.fromEntries(head.map((k, i) => [k, cells[i] ?? '']));
}

export function parseCsv(text: string): CsvRecord[] {
  const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
  const [first, ...rest] = lines;
  if (!first || rest.length === 0) return [];
  const head = parseCsvLine(first);
  return rest.map(line => toRecord(head, line));
}
