import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = path.resolve(process.env.STATE_DIR || 'data');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TMP_FILE = `${STATE_FILE}.tmp`;

export const STATE_VERSION = 1;
export { STATE_FILE };

// null означает «начать с чистого листа»: файла нет, он битый или от другой версии.
export async function loadState() {
  let raw;
  try {
    raw = await readFile(STATE_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Состояние не прочитано (${err.message}) — старт с нуля.`);
    return null;
  }

  try {
    const state = JSON.parse(raw);
    if (state?.version !== STATE_VERSION) {
      console.warn(`Версия состояния ${state?.version} не поддерживается — старт с нуля.`);
      return null;
    }
    return state;
  } catch (err) {
    console.warn(`Состояние повреждено (${err.message}) — старт с нуля.`);
    return null;
  }
}

// Запись через временный файл: обрыв питания не оставит половину JSON.
export async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(TMP_FILE, JSON.stringify(state, null, 2));
  await rename(TMP_FILE, STATE_FILE);
}
