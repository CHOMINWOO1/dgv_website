import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  abbreviateTelegramText,
  escapeTelegramHtml,
  MAX_TELEGRAM_MESSAGE_LENGTH,
  renderNextSummaryChunk,
} from "../supabase/functions/tg_notify_v2/message-utils.ts";
import {
  renderDailySummaryMessage,
  renderReservationDelivery,
  renderReservationMessage,
  renderSummaryDelivery,
} from "../supabase/functions/tg_notify_v2/message-rendering.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertNoUnpairedSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.ok(index + 1 < value.length, "dangling high surrogate");
      const low = value.charCodeAt(index + 1);
      assert.ok(low >= 0xdc00 && low <= 0xdfff, "unpaired high surrogate");
      index += 1;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, "unpaired low surrogate");
    }
  }
}

// Escaping itself is lossless. Adaptive abbreviation is a separate operation
// and therefore cannot alter existing messages that already fit Telegram.
const entitySource = "&<>\"'".repeat(300);
const entityEscaped = escapeTelegramHtml(entitySource);
assert.equal(entityEscaped, "&amp;&lt;&gt;&quot;&#39;".repeat(300));
assert.doesNotMatch(entityEscaped, /\.\.\.$/);

const abbreviatedEntities = abbreviateTelegramText(entitySource, 256);
const abbreviatedEntitiesEscaped = escapeTelegramHtml(abbreviatedEntities);
assert.ok(abbreviatedEntitiesEscaped.length <= 256);
assert.match(abbreviatedEntities, /\.\.\.$/);
assert.doesNotMatch(
  abbreviatedEntitiesEscaped,
  /&(?:a|am|amp|l|g|q|qu|quo|#|#3|#39)$/,
);

const abbreviatedUnicode = abbreviateTelegramText("😀".repeat(300), 256);
assert.ok(escapeTelegramHtml(abbreviatedUnicode).length <= 256);
assert.match(abbreviatedUnicode, /\.\.\.$/);
assertNoUnpairedSurrogates(abbreviatedUnicode);

const smallNote = "n".repeat(300);
const smallReservation = {
  res_date: "2026-08-08",
  res_time: "18:30:00",
  branch: "DGV & 1",
  guests_count: 12,
  menu_ko: "메뉴 <A>",
  menu_vi: "Thực đơn",
  guide_name: 'Guide "A"',
  note: smallNote,
};
const expectedReservation =
  `📌 <b>ĐẶT BÀN ĐOÀN MỚI</b>\n` +
  `• Ngày: <b>08/08/2026</b>\n` +
  `• Giờ: <b>18:30</b>\n` +
  `• Chi nhánh: <b>DGV &amp; 1</b>\n` +
  `• Số khách: <b>12</b>\n` +
  `• Món ăn: <b>메뉴 &lt;A&gt;</b> (Thực đơn)\n` +
  `• Hướng dẫn viên: <b>Guide &quot;A&quot;</b>\n` +
  `• Ghi chú: ${smallNote}`;
assert.equal(renderReservationMessage(smallReservation), expectedReservation);
const smallReservationDelivery = renderReservationDelivery(smallReservation);
assert.equal(smallReservationDelivery.message, expectedReservation);
assert.equal(smallReservationDelivery.nextCursor, 1);
assert.equal(smallReservationDelivery.completed, true);
assert.doesNotMatch(smallReservationDelivery.message, /\.\.\.$/);

const smallSummary = {
  date: "2026-08-08",
  rows: [{
    res_time: "18:30:00",
    branch: "DGV & 1",
    guests_count: 12,
    price: 100000,
    menu_ko: "메뉴 <A>",
    menu_vi: "Thực đơn",
    guide_name: 'Guide "A"',
    note: smallNote,
  }],
};
const expectedDailySummary =
  `☀️ <b>오늘 단체예약</b> (2026-08-08)\n` +
  `\n\n🗓 <b>18:30:00</b> • <b>DGV &amp; 1</b>\n` +
  `- 인원: 12 / 가격: 100000 VND\n` +
  `- 메뉴: 메뉴 &lt;A&gt; (Thực đơn)\n` +
  `- 가이드: Guide &quot;A&quot;\n` +
  `- 메모: ${smallNote}`;
assert.equal(renderDailySummaryMessage(smallSummary), expectedDailySummary);
const smallSummaryDelivery = renderSummaryDelivery(
  "daily_summary",
  smallSummary,
  0,
);
assert.equal(smallSummaryDelivery.message, expectedDailySummary);
assert.equal(smallSummaryDelivery.nextCursor, 1);
assert.equal(smallSummaryDelivery.completed, true);

const rows = Array.from({ length: 100 }, (_, index) => ({
  res_time: `${String(index % 24).padStart(2, "0")}:00:00`,
  branch: `BRANCH-row-${String(index).padStart(3, "0")}`,
  guests_count: index + 1,
  price: 100000 + index,
  menu_ko: "&".repeat(500),
  menu_vi: "&".repeat(500),
  guide_name: "&".repeat(200),
  note: "&😀".repeat(500),
}));
const largeSummary = { date: "2099-12-31", rows };
const deliveredMessages = [];
let cursor = 0;
while (cursor < rows.length) {
  const delivery = renderSummaryDelivery("daily_summary", largeSummary, cursor);
  assert.ok(delivery.nextCursor > cursor, "row cursor did not advance");
  assert.ok(delivery.nextCursor <= rows.length, "row cursor exceeded rows[]");
  assert.ok(delivery.message.length <= MAX_TELEGRAM_MESSAGE_LENGTH);
  assert.match(delivery.message, /^☀️ <b>오늘 단체예약<\/b> \(2099-12-31\)\n/);
  assertNoUnpairedSurrogates(delivery.message);
  deliveredMessages.push(delivery.message);
  cursor = delivery.nextCursor;
}
assert.ok(deliveredMessages.length > 1, "large summary did not split");
for (const row of rows) {
  const marker = row.branch;
  assert.equal(
    deliveredMessages.reduce(
      (count, message) => count + message.split(marker).length - 1,
      0,
    ),
    1,
    `${marker} was omitted or duplicated`,
  );
}

// A changed packing policy can safely continue from the prior next-row index.
const deployRows = Array.from({ length: 12 }, (_, id) => ({ id }));
const renderWithWidth = (width) => (payload) =>
  `<b>summary</b>\n` + payload.rows.map((row) =>
    `row-${row.id}:${"x".repeat(width)}`
  ).join("\n");
const beforeDeploy = renderNextSummaryChunk(
  { rows: deployRows },
  0,
  renderWithWidth(900),
);
assert.ok(beforeDeploy.nextCursor > 0 && beforeDeploy.nextCursor < deployRows.length);
const deliveredRowIds = deployRows.slice(0, beforeDeploy.nextCursor).map(({ id }) => id);
cursor = beforeDeploy.nextCursor;
while (cursor < deployRows.length) {
  const afterDeploy = renderNextSummaryChunk(
    { rows: deployRows },
    cursor,
    renderWithWidth(1700),
  );
  deliveredRowIds.push(
    ...deployRows.slice(cursor, afterDeploy.nextCursor).map(({ id }) => id),
  );
  cursor = afterDeploy.nextCursor;
}
assert.deepEqual(deliveredRowIds, deployRows.map(({ id }) => id));

const emptySummary = renderSummaryDelivery(
  "tomorrow_summary",
  { date: "2099-12-31", rows: [] },
  0,
);
assert.equal(emptySummary.nextCursor, 1);
assert.equal(emptySummary.completed, true);

const edgeSource = await readFile(
  path.join(projectRoot, "supabase/functions/tg_notify_v2/index.ts"),
  "utf8",
);
assert.match(
  edgeSource,
  /from "npm:@supabase\/supabase-js@2\.112\.2"/,
  "Edge import must be deployable without an import map",
);
assert.match(edgeSource, /await sendTelegram\(rendered\.message\)/);
assert.equal(
  edgeSource.match(/await sendTelegram\(/g)?.length,
  1,
  "an invocation must send exactly one row-indexed message",
);

const advanceBlock = edgeSource.slice(
  edgeSource.indexOf("async function advanceDeliveryCursor"),
  edgeSource.indexOf("function storedError"),
);
assert.match(advanceBlock, /\.eq\("status", "processing"\)/);
assert.match(advanceBlock, /\.eq\("attempts", expectedAttempts\)/);
assert.match(advanceBlock, /\.eq\("delivery_cursor", expectedCursor\)/);

const failureBlock = edgeSource.slice(
  edgeSource.indexOf("async function markFailed"),
  edgeSource.indexOf("function responseForExistingState"),
);
assert.match(failureBlock, /\.eq\("status", "processing"\)/);
assert.match(failureBlock, /\.eq\("attempts", expectedAttempts\)/);
assert.match(failureBlock, /\.eq\("delivery_cursor", expectedCursor\)/);

const utilitySource = await readFile(
  path.join(projectRoot, "supabase/functions/tg_notify_v2/message-utils.ts"),
  "utf8",
);
assert.match(utilitySource, /payload\.rows\.slice\(cursor\)/);

const cursorMigration = await readFile(
  path.join(
    projectRoot,
    "supabase/migrations/20260807140205_notification_delivery_cursor.sql",
  ),
  "utf8",
);
assert.match(cursorMigration, /delivery_cursor integer not null default 0/i);
assert.match(cursorMigration, /delivery_cursor between 0 and 100/i);
assert.match(cursorMigration, /next unsent summary rows\[\] index/i);

const denoConfig = JSON.parse(await readFile(
  path.join(projectRoot, "supabase/functions/tg_notify_v2/deno.json"),
  "utf8",
));
assert.deepEqual(
  denoConfig.imports,
  {},
  "the legacy deployment import map must stay empty because imports are pinned in source",
);

console.log("Notification row-cursor and adaptive-rendering contracts passed.");
