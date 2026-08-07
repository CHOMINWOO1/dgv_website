import {
  abbreviateTelegramText,
  escapeTelegramHtml,
  MAX_TELEGRAM_MESSAGE_LENGTH,
  renderNextSummaryChunk,
  type RenderedSummaryChunk,
  type TelegramDisplayValue,
} from "./message-utils.ts";

export interface ReservationMessagePayload {
  res_date?: string | null;
  res_time?: string | null;
  branch?: string | null;
  guests_count?: string | number | null;
  menu_ko?: string | null;
  menu_vi?: string | null;
  guide_name?: string | null;
  note?: string | null;
}

export interface SummaryMessageRow {
  res_time?: string | null;
  branch?: string | null;
  guests_count?: string | number | null;
  price?: string | number | null;
  menu_ko?: string | null;
  menu_vi?: string | null;
  guide_name?: string | null;
  note?: string | null;
}

export interface SummaryMessagePayload {
  date?: string | null;
  rows: SummaryMessageRow[];
}

export type RenderedDelivery = RenderedSummaryChunk;

type SummaryEventType = "daily_summary" | "tomorrow_summary";

const ABBREVIATION_ORDER = [
  "note",
  "menu_vi",
  "menu_ko",
  "guide_name",
  "branch",
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateVN(value: TelegramDisplayValue): string {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return `${pad2(parsed.getDate())}/${
    pad2(parsed.getMonth() + 1)
  }/${parsed.getFullYear()}`;
}

function formatTimeHHMM(value: TelegramDisplayValue): string {
  if (value === null || value === undefined) return "-";
  const text = String(value).trim();
  if (!text) return "-";
  return text.length >= 5 ? text.slice(0, 5) : text;
}

export function renderReservationMessage(
  payload: ReservationMessagePayload,
): string {
  const menuVi = payload.menu_vi
    ? ` (${escapeTelegramHtml(payload.menu_vi)})`
    : "";
  return (
    `📌 <b>ĐẶT BÀN ĐOÀN MỚI</b>\n` +
    `• Ngày: <b>${escapeTelegramHtml(formatDateVN(payload.res_date))}</b>\n` +
    `• Giờ: <b>${escapeTelegramHtml(formatTimeHHMM(payload.res_time))}</b>\n` +
    `• Chi nhánh: <b>${escapeTelegramHtml(payload.branch)}</b>\n` +
    `• Số khách: <b>${escapeTelegramHtml(payload.guests_count)}</b>\n` +
    `• Món ăn: <b>${escapeTelegramHtml(payload.menu_ko)}</b>${menuVi}\n` +
    `• Hướng dẫn viên: <b>${escapeTelegramHtml(payload.guide_name)}</b>\n` +
    `• Ghi chú: ${escapeTelegramHtml(payload.note)}`
  );
}

export function renderDailySummaryMessage(
  payload: SummaryMessagePayload,
): string {
  let message = `☀️ <b>오늘 단체예약</b> (${
    escapeTelegramHtml(payload.date, "")
  })\n`;
  if (payload.rows.length === 0) return message + "\n예약 없음";

  for (const row of payload.rows) {
    const menuVi = row.menu_vi ? ` (${escapeTelegramHtml(row.menu_vi)})` : "";
    message +=
      `\n\n🗓 <b>${escapeTelegramHtml(row.res_time)}</b> • <b>${
        escapeTelegramHtml(row.branch)
      }</b>` +
      `\n- 인원: ${escapeTelegramHtml(row.guests_count)} / 가격: ${
        escapeTelegramHtml(row.price)
      } VND` +
      `\n- 메뉴: ${escapeTelegramHtml(row.menu_ko)}${menuVi}` +
      `\n- 가이드: ${escapeTelegramHtml(row.guide_name)}` +
      (row.note ? `\n- 메모: ${escapeTelegramHtml(row.note)}` : "");
  }
  return message;
}

export function renderTomorrowSummaryMessage(
  payload: SummaryMessagePayload,
): string {
  let message = `🌙 <b>LỊCH ĐẶT BÀN ĐOÀN NGÀY MAI</b> (${
    escapeTelegramHtml(formatDateVN(payload.date))
  })\n`;
  if (payload.rows.length === 0) {
    return message + "\nKhông có đặt bàn cho ngày mai";
  }

  for (const row of payload.rows) {
    const menuVi = row.menu_vi ? ` (${escapeTelegramHtml(row.menu_vi)})` : "";
    message +=
      `\n\n🗓 <b>${escapeTelegramHtml(formatTimeHHMM(row.res_time))}</b> • <b>${
        escapeTelegramHtml(row.branch)
      }</b>` +
      `\n- Số khách: ${escapeTelegramHtml(row.guests_count)} / Giá: ${
        escapeTelegramHtml(row.price)
      } VND` +
      `\n- Món: ${escapeTelegramHtml(row.menu_ko)}${menuVi}` +
      `\n- HDV: ${escapeTelegramHtml(row.guide_name)}` +
      (row.note ? `\n- Ghi chú: ${escapeTelegramHtml(row.note)}` : "");
  }
  return message;
}

function abbreviateRecordToFit<
  RecordType extends ReservationMessagePayload | SummaryMessageRow,
>(
  record: RecordType,
  render: (candidate: RecordType) => string,
): RecordType {
  let adjusted = { ...record } as RecordType;
  let message = render(adjusted);
  if (message.length <= MAX_TELEGRAM_MESSAGE_LENGTH) return adjusted;

  for (const key of ABBREVIATION_ORDER) {
    const value = adjusted[key];
    if (value === null || value === undefined || value === "") continue;

    const currentEscapedLength = escapeTelegramHtml(value, "").length;
    const overflow = message.length - MAX_TELEGRAM_MESSAGE_LENGTH;
    const targetEscapedLength = Math.max(3, currentEscapedLength - overflow);
    adjusted = {
      ...adjusted,
      [key]: abbreviateTelegramText(value, targetEscapedLength),
    };
    message = render(adjusted);
    if (message.length <= MAX_TELEGRAM_MESSAGE_LENGTH) return adjusted;
  }

  throw new RangeError(
    "message exceeds Telegram limit after adaptive field abbreviation",
  );
}

export function renderReservationDelivery(
  payload: ReservationMessagePayload,
): RenderedDelivery {
  const adjusted = abbreviateRecordToFit(payload, renderReservationMessage);
  const message = renderReservationMessage(adjusted);
  if (message.length === 0 || message.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new RangeError("reservation message exceeds Telegram limit");
  }
  return { message, nextCursor: 1, completed: true };
}

export function renderSummaryDelivery(
  eventType: SummaryEventType,
  payload: SummaryMessagePayload,
  cursor: number,
): RenderedDelivery {
  const render = eventType === "daily_summary"
    ? renderDailySummaryMessage
    : renderTomorrowSummaryMessage;

  const rows = payload.rows.map((row) =>
    abbreviateRecordToFit(
      row,
      (candidate) => render({ date: payload.date, rows: [candidate] }),
    )
  );

  return renderNextSummaryChunk({ ...payload, rows }, cursor, render);
}
