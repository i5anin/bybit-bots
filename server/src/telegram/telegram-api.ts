// Тонкий клиент Bot API: только методы, которые нужны оповещениям.
// Ошибки не бросаются наружу — каждый вызов возвращает ok и описание отказа,
// чтобы сервис мог откатиться на более простой способ отправки.

export interface ApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface SendOptions {
  silent?: boolean;
}

export interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string; date?: number };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

export const PHOTO_ID = 'report';

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async call<T = unknown>(
    method: string,
    body: Record<string, unknown> | FormData,
    timeoutMs = 20_000,
    abort?: AbortSignal,
  ): Promise<ApiResult<T>> {
    try {
      const init: RequestInit = body instanceof FormData
        ? { method: 'POST', body }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        ...init,
        signal: abort ? AbortSignal.any([abort, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResult<T>;
      if (res.ok && json.ok) return json;
      return { ok: false, description: json.description ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, description: (err as Error).message };
    }
  }

  // Rich-сообщение (Bot API 10.3): заголовки, таблицы, сворачиваемые блоки.
  // Картинка загружается в том же запросе и вставляется ссылкой tg://photo?id=report.
  async sendRichMessage(html: string, photo: Buffer | null, opts: SendOptions = {}): Promise<ApiResult> {
    const richMessage: Record<string, unknown> = { html, skip_entity_detection: true };
    if (!photo) {
      return this.call('sendRichMessage', { chat_id: this.chatId, rich_message: richMessage, disable_notification: Boolean(opts.silent) });
    }
    richMessage.media = [{ id: PHOTO_ID, media: { type: 'photo', media: `attach://${PHOTO_ID}` } }];
    const form = new FormData();
    form.set('chat_id', this.chatId);
    form.set('rich_message', JSON.stringify(richMessage));
    form.set('disable_notification', String(Boolean(opts.silent)));
    form.set(PHOTO_ID, new Blob([new Uint8Array(photo)], { type: 'image/png' }), `${PHOTO_ID}.png`);
    return this.call('sendRichMessage', form, 60_000);
  }

  // Классические методы — запасной путь, если rich-сообщение не прошло.
  async sendMessage(html: string, opts: SendOptions = {}): Promise<ApiResult> {
    return this.call('sendMessage', {
      chat_id: this.chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: Boolean(opts.silent),
    });
  }

  async sendPhoto(photo: Buffer, captionHtml: string, opts: SendOptions = {}): Promise<ApiResult> {
    const form = new FormData();
    form.set('chat_id', this.chatId);
    form.set('caption', captionHtml);
    form.set('parse_mode', 'HTML');
    form.set('disable_notification', String(Boolean(opts.silent)));
    form.set('photo', new Blob([new Uint8Array(photo)], { type: 'image/png' }), 'report.png');
    return this.call('sendPhoto', form, 60_000);
  }

  // Черновик rich-сообщения: виден до 30 секунд, изменения с тем же draftId
  // Telegram показывает анимацией. Пропадает, когда приходит настоящее сообщение.
  async sendDraft(draftId: number, html: string): Promise<ApiResult> {
    return this.call('sendRichMessageDraft', {
      chat_id: Number(this.chatId),
      draft_id: draftId,
      rich_message: { html, skip_entity_detection: true },
    });
  }

  // Статус «отправляет фото…» на 5 секунд — запасная анимация.
  async chatAction(action: 'typing' | 'upload_photo'): Promise<ApiResult> {
    return this.call('sendChatAction', { chat_id: this.chatId, action });
  }

  // Команды в меню бота: «/» в чате показывает их с описанием.
  async setCommands(commands: readonly { command: string; description: string }[]): Promise<ApiResult> {
    return this.call('setMyCommands', { commands });
  }

  // Длинный опрос: Telegram держит запрос до timeoutSec, пока нет новых событий.
  async getUpdates(offset: number, timeoutSec: number, abort?: AbortSignal): Promise<ApiResult<Update[]>> {
    return this.call<Update[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    }, (timeoutSec + 15) * 1000, abort);
  }

  async answerCallback(id: string, text: string): Promise<ApiResult> {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }
}
