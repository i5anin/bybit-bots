// Экранирование по RFC 4180: имена стратегий содержат запятые
// («RSI (14, 30/70)») и без кавычек ломают любой парсер.
const NEEDS_QUOTES = /["\n\r,]/;

export function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values) {
  return values.map(csvField).join(',') + '\n';
}

// Разбор одной строки CSV с учётом кавычек — нужен скриптам миграции.
export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}
