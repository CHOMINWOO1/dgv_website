export const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

const TRUNCATION_MARKER = "...";

export type TelegramDisplayValue = string | number | null | undefined;

interface SummaryPayloadLike<Row> {
  date?: string | null;
  rows: Row[];
}

export interface RenderedSummaryChunk {
  message: string;
  nextCursor: number;
  completed: boolean;
}

function encodeTelegramHtmlCharacter(character: string): string {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&#39;";
    default:
      return character;
  }
}

/**
 * Escapes a Telegram HTML text node without changing its content. Adaptive
 * abbreviation is applied separately and only when a complete message would
 * otherwise exceed Telegram's limit.
 */
export function escapeTelegramHtml(
  value: TelegramDisplayValue,
  fallback = "-",
): string {
  const text = value === null || value === undefined ? fallback : String(value);
  return Array.from(text, encodeTelegramHtmlCharacter).join("");
}

/**
 * Abbreviates source text to a maximum escaped length without splitting an
 * HTML entity or a Unicode surrogate pair. The returned value is unescaped.
 */
export function abbreviateTelegramText(
  value: TelegramDisplayValue,
  maxEscapedLength: number,
): string {
  const text = value === null || value === undefined ? "" : String(value);
  const fullyEscaped = escapeTelegramHtml(text, "");
  if (fullyEscaped.length <= maxEscapedLength) return text;
  if (maxEscapedLength < TRUNCATION_MARKER.length) {
    throw new RangeError("abbreviation limit is too small");
  }

  let escapedLength = 0;
  let abbreviated = "";
  const contentLimit = maxEscapedLength - TRUNCATION_MARKER.length;
  for (const character of text) {
    const encoded = encodeTelegramHtmlCharacter(character);
    if (escapedLength + encoded.length > contentLimit) break;
    abbreviated += character;
    escapedLength += encoded.length;
  }
  return abbreviated + TRUNCATION_MARKER;
}

function assertTelegramMessageLength(message: string): void {
  if (
    message.length === 0 ||
    message.length > MAX_TELEGRAM_MESSAGE_LENGTH
  ) {
    throw new RangeError(
      `rendered message must be between 1 and ${MAX_TELEGRAM_MESSAGE_LENGTH} characters`,
    );
  }
}

/**
 * Renders exactly one chunk beginning at the next unsent rows[] index. The
 * cursor is a row position rather than a chunk ordinal, so deploying a changed
 * packing strategy between invocations cannot omit or replay completed rows.
 * A row is never split; the summary header is repeated on every invocation.
 */
export function renderNextSummaryChunk<Row>(
  payload: SummaryPayloadLike<Row>,
  cursor: number,
  render: (candidate: SummaryPayloadLike<Row>) => string,
): RenderedSummaryChunk {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > payload.rows.length) {
    throw new RangeError("summary delivery cursor is outside rows[]");
  }

  if (payload.rows.length === 0) {
    if (cursor !== 0) {
      throw new RangeError("empty summary delivery cursor must be zero");
    }
    const emptyMessage = render({ ...payload, rows: [] });
    assertTelegramMessageLength(emptyMessage);
    return { message: emptyMessage, nextCursor: 1, completed: true };
  }

  if (cursor === payload.rows.length) {
    throw new RangeError("summary has no unsent row at delivery cursor");
  }

  let rows: Row[] = [];
  let message = "";
  let nextCursor = cursor;

  const remainingRows = payload.rows.slice(cursor);
  for (let offset = 0; offset < remainingRows.length; offset += 1) {
    const row = remainingRows[offset];
    const candidateRows = [...rows, row];
    const candidateMessage = render({ ...payload, rows: candidateRows });

    if (candidateMessage.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
      rows = candidateRows;
      message = candidateMessage;
      nextCursor = cursor + offset + 1;
      continue;
    }

    if (rows.length === 0) {
      throw new RangeError(
        "a single abbreviated summary row exceeds the Telegram message limit",
      );
    }
    break;
  }

  assertTelegramMessageLength(message);
  return {
    message,
    nextCursor,
    completed: nextCursor === payload.rows.length,
  };
}
