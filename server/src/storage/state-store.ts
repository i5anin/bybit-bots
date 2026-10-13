import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineState } from '../trading/types.js';

// Версия формата data/state.json. Та же, что у JS-версии: состояние переходит
// на новый движок без сброса.
export const STATE_VERSION = 1;

export class StateStore {
  readonly file: string;
  private readonly tmp: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'state.json');
    this.tmp = `${this.file}.tmp`;
  }

  // null означает «начать с чистого листа»: файла нет, он битый или от другой версии.
  async load(): Promise<EngineState | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      const state = JSON.parse(raw) as EngineState;
      return state?.version === STATE_VERSION ? state : null;
    } catch {
      return null;
    }
  }

  // Запись через временный файл: обрыв питания не оставит половину JSON.
  async save(state: EngineState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.tmp, JSON.stringify(state, null, 2));
    await rename(this.tmp, this.file);
  }
}
