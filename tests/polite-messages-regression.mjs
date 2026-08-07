import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "calc.html",
  "admin.html",
  "hana_admin_hidden.html",
  "code_admin.html",
  "notice.html",
  "reservation.html",
  "reserv_check.html",
  "reserv_admin.html",
  "report.html",
];

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]))
    .map((match) => match[2])
    .join("\n");
}

const bannedMessageFragments = [
  "필수야",
  "입력해줘",
  "선택해줘",
  "확인해줘",
  "필요해",
  "클 수 없어",
  "예약이야",
  "진행할까요?",
  "정말 삭제할까요?",
  "팝업이 차단됨",
  "로그인 실패",
  "출력 실패",
  "전체 출력 실패",
  "메뉴 로드 실패",
  "주문 메타 로드 실패",
  "주문 라인 로드 실패",
  "SPECIAL 로드 실패",
  "저장 완료!",
  "삭제 완료!",
];

const bannedVisibleFragments = [
  "데이터 없음",
  "선택됨",
  "입력한 값이 저장됨",
  "VI 자동 입력",
  "손님 요청으로 임시 메뉴를 여러 개 추가 가능",
  "대상 아님",
];

const pages = new Map();
for (const file of files) {
  const html = await readFile(path.join(projectRoot, file), "utf8");
  const scripts = inlineScripts(html);
  pages.set(file, scripts);

  for (const fragment of bannedVisibleFragments) {
    assert.equal(
      html.includes(fragment),
      false,
      `${file} still contains fragmentary visible copy: ${fragment}`,
    );
  }

  for (const fragment of bannedMessageFragments) {
    assert.equal(
      scripts.includes(fragment),
      false,
      `${file} still contains informal or fragmentary message copy: ${fragment}`,
    );
  }

  assert.doesNotMatch(
    scripts,
    /(?:alert|setMsg|setSavedMsg)\([^\n]*(?:e|error)\.message/,
    `${file} exposes a raw database/runtime error in a user-facing message`,
  );
}

for (const file of ["admin.html", "hana_admin_hidden.html"]) {
  const scripts = pages.get(file);
  assert.match(scripts, /sb\.rpc\("app_delete_order"/);
  assert.match(
    scripts,
    /이 주문을 삭제하시겠습니까\?\\n삭제한 주문은 복구할 수 없습니다\./,
  );
  assert.match(
    scripts,
    /예약 확정으로 생성된 주문은 이 페이지에서 직접 삭제할 수 없습니다\. 예약 관리 페이지에서 확정을 취소해 주세요\./,
  );
}

console.log(`Polite message copy verified across ${files.length} protected pages.`);
