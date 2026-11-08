# HANA Karaoke 운영 안내

정적 페이지와 Supabase Edge Function/Postgres/Realtime으로 동작합니다. 별도 Node 서버는 필요하지 않습니다. 현재 방 만들기는 로그인·비밀번호 없이 공개되어 있으며, 기존 DGV 업무용 로그인과 분리되어 있습니다.

## 구성과 배포

- 화면: `hana_karaoke.html`, `assets/hana-karaoke.js`, `assets/hana-karaoke.css`
- API: `supabase/functions/hana-karaoke/index.ts` → `POST /functions/v1/hana-karaoke`
- 적용된 초기 마이그레이션: `supabase/migrations/20261108044359_hana_karaoke_serverless.sql`
- 초기 백엔드 배포: 2026-11-08, Edge Function `hana-karaoke` v1. 정적 사이트 공개는 별도 배포 단계입니다.

다른 환경에 설치할 때는 다음을 확인합니다.

1. 대상 프로젝트를 확인하고 **위 karaoke 마이그레이션만** 승인된 절차로 적용합니다. 관계없는 미적용 마이그레이션을 일괄 실행하지 않습니다. `scripts/karaoke-schema.sql`은 작성용 초안이며 마이그레이션 대신 중복 적용하지 않습니다.
2. Edge Function을 배포할 때 **`verify_jwt=false`**를 설정합니다. 이 함수는 자체 초대 토큰을 검증합니다. Supabase 익명 로그인은 켜지 않습니다. 재배포 설정에도 아래 항목을 유지합니다.
3. 서버 환경변수 `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`의 `default` 키를 확인합니다. 새 키가 없으면 기존 `SUPABASE_SERVICE_ROLE_KEY`를 사용합니다. 공개 키 확인에는 `SUPABASE_PUBLISHABLE_KEYS` 또는 `SUPABASE_ANON_KEY`를 사용합니다.
4. 별도의 안정적인 무작위 비밀값 `KARAOKE_TOKEN_SECRET` 사용을 권장합니다. 없으면 서버 API 키를 사용합니다. 이 값 또는 대체 서버 키의 변경은 이미 성공한 **방 만들기 요청의 재시도 복구**를 중단시킬 수 있습니다. 기존 방 토큰 자체는 만료까지 유효합니다.
5. 브라우저는 기존 `assets/supabase-config.js`의 URL과 **공개 키만** 사용합니다. 서버 비밀값을 브라우저 파일에 넣지 않습니다. 페이지·자산을 승인된 정적 사이트 배포에 포함합니다. Pages 빌드는 추적된 공개 파일만 포함합니다.

```toml
[functions.hana-karaoke]
verify_jwt = false
```

공유 `config.toml`을 수정하지 않고 CLI로 배포할 때는 `supabase functions deploy hana-karaoke --project-ref <대상 프로젝트> --no-verify-jwt`처럼 해당 함수에만 옵션을 지정합니다.

허용 브라우저 출처는 `https://dalatgolfvoucher.com`, `https://www.dalatgolfvoucher.com`, 그리고 정확한 `localhost`/`127.0.0.1` HTTP(S) 출처입니다. 다른 도메인을 사용하려면 Edge의 출처 목록을 검토해야 합니다. CORS는 인증이나 DDoS 방어를 대신하지 않습니다.

## 사용 방법

1. TV 또는 TV에 연결한 컴퓨터에서 `hana_karaoke.html`을 열고 **TV에서 방 만들기**를 누릅니다. 한국어·베트남어·영어를 선택할 수 있습니다.
2. 휴대폰으로 TV의 QR을 스캔하거나 **초대 링크**를 엽니다. 처음 연결하는 기기는 6자리 코드만으로 입장할 수 없습니다. 코드는 같은 탭에 초대 정보가 저장되어 있을 때 다시 연결하는 용도입니다.
3. YouTube에서 노래방 영상을 찾고 공유 링크 또는 영상 ID를 넣어 **예약 추가**를 누릅니다. 검색은 YouTube 새 창을 열며, 영상 다운로드나 검색 API 키는 사용하지 않습니다.
4. TV에서 첫 재생을 직접 시작합니다. 휴대폰에서는 예약 추가·삭제·순서 변경과 재생·일시정지·다음 곡을 제어합니다. TV에서 곡이 끝나면 다음 예약으로 넘어갑니다.
5. 끝나면 TV의 **방 종료**를 누릅니다. **나가기** 또는 TV 탭 닫기는 방 종료와 다릅니다. 방은 생성 24시간 후 만료됩니다.

TV 탭을 유지하세요. 호스트/초대 정보는 탭의 `sessionStorage`에 보관되므로 탭을 닫거나 저장소를 지우면 호스트 권한을 잃을 수 있습니다. 초대 링크는 함께 사용할 사람에게만 공유합니다. 링크를 가진 사람은 예약과 재생을 제어할 수 있습니다.

일부 스마트 TV, 자동재생 정책, 연령·지역·삽입 제한 영상은 재생을 막을 수 있습니다. TV에서 재생 버튼을 직접 누르거나 다른 허용 영상을 사용하세요. 영상 재생은 YouTube 및 네트워크 상태에 의존하며 모든 TV 브라우저 호환을 보장하지 않습니다.

## 보안과 제한

- `hana_karaoke_rooms`와 `hana_karaoke_settings`만 추가합니다. 기존 주문·골프·업무 테이블, 역할, 정책, Auth 설정은 변경하지 않습니다.
- 새 테이블은 RLS와 서비스 전용 권한을 사용합니다. `anon`, `authenticated`, `PUBLIC`에는 테이블/RPC 접근 권한이 없습니다. RPC는 `SECURITY INVOKER`이며 Edge의 서버 권한으로만 호출합니다.
- 호스트/초대 토큰은 서로 다른 256비트 HMAC 값이고 DB에는 SHA-256 해시만 저장합니다. 방 만들기 재시도는 요청 UUID와 해시된 IP에 묶입니다. 응답을 받지 못한 사이 네트워크/IP가 바뀌면 같은 요청의 복구가 실패할 수 있습니다.
- 호스트 토큰은 URL에 넣지 않습니다. 공유하는 초대 토큰은 URL fragment에 넣고 입장 시 주소에서 제거합니다. 방 코드 자체는 인증 수단이 아닙니다.
- 모든 변경은 방 행 잠금으로 직렬화합니다. 최근 50개 요청 ID/지문으로 재시도를 중복 실행하지 않으며, 현재 곡 ID 확인으로 중복 종료 이벤트가 두 곡을 넘기는 것을 막습니다. 오래된 요청의 재시도를 무기한 보장하지 않습니다.
- Realtime은 별도 무작위 공개 채널에 `{revision}` 알림만 전송합니다. 클라이언트는 알림 내용을 상태로 신뢰하지 않고 토큰 인증 API로 다시 조회합니다. 전송 실패가 이미 저장된 변경을 취소하지 않습니다.

| 항목 | 제한 |
| --- | --- |
| 방 수명 / 활성 방 | 24시간 / 최대 50개 |
| 새 방 생성 | 해시된 IP별 시간당 10개, 전체 시간당 30개 |
| 예약 목록 / 제목 / 요청 본문 | 최대 50곡 / 100문자 / 16 KiB |
| 실제 상태 변경 | 방별 10초당 30회 |
| 상태·재시도 등 성공 가능한 요청 | 방별 분당 600회, 초대 사용자 전체 공유 |
| 자동 상태 조회 | 알림 조회 최소 간격 5초; 연결 불량 시 60초; 정상 연결도 5분마다 재확인 |

만료 방은 접근할 수 없습니다. 만료 후 7일이 지난 행은 이후 새 방 생성 시 정리되며 별도 예약 정리 작업은 없습니다. 이 제한들은 저장량과 정상 요청을 제한하지만, 거부된 요청도 Edge/DB 자원을 사용할 수 있습니다. 기존 업무와 같은 프로젝트의 할당량을 공유하므로 **영구 무료 또는 업무 영향 없음은 보장하지 않습니다**. 공개 운영 시 사용량을 확인하세요.

## 나중에 직원만 방을 만들게 하기

서버에는 `hana_karaoke_settings.require_staff_to_create` 설정이 준비되어 있습니다. Edge는 기존 Auth의 `/auth/v1/user`로 사용자를 확인하고 `app_metadata.role`이 `staff`, `manager`, `admin`인지 검사합니다. 사용자 수정 가능한 `user_metadata`는 권한으로 사용하지 않습니다.

**현재 karaoke 화면에는 직원 로그인 및 사용자 JWT 전달이 연결되어 있지 않습니다.** 아래 설정만 먼저 켜면 화면에서 방 만들기가 차단됩니다. 먼저 별도로 승인된 로그인 흐름을 연결·검증한 다음, 관리자 SQL에서 이 기능의 설정만 변경합니다. 기존 방의 초대 토큰 제어에는 영향이 없습니다.

```sql
update public.hana_karaoke_settings
set require_staff_to_create = true
where singleton = true;
-- 공개 생성으로 되돌릴 때는 false로 변경합니다.
```

## 테스트

저장소 루트에서 Node 24로 실행합니다. Edge 테스트는 환경변수와 네트워크 호출을 모두 모의 처리하며 운영 서버를 호출하지 않습니다.

```powershell
node --experimental-strip-types --test tests/karaoke-edge.mjs
```

DB 테스트는 메모리 내 PGlite를 사용합니다. `@electric-sql/pglite`가 로컬에 있으면 바로 실행할 수 있고, 별도 설치를 사용할 때는 해당 모듈의 절대 경로를 지정합니다. 검증 버전은 `0.5.15`이며 앱 런타임 의존성은 아닙니다.

```powershell
$env:PGLITE_MODULE = 'C:\path\to\pglite\dist\index.js'
node tests/karaoke-db.mjs
```

2026-11-08, 마이그레이션 파일명 정렬 후 재검증: **DB 40개 검사 통과, Edge 45개 테스트 통과**. Chrome의 TV/390px 모바일 화면을 실제 API와 Realtime에 연결한 브라우저 통합 테스트도 30개 검사 통과했습니다. 통합 테스트의 YouTube 플레이어는 모의 처리하므로 실제 TV·휴대폰의 영상/자동재생 호환 검증은 별도로 수행해야 합니다.

`tests/karaoke-browser.mjs`는 명시적으로 실행할 때만 실제 테스트용 방을 만들며 종료 시 그 방을 닫습니다. 다른 업무 데이터는 사용하지 않습니다. Playwright/Chrome이 준비된 환경에서 실행합니다.

```powershell
$env:LIVE_KARAOKE_TEST = '1'
$env:PLAYWRIGHT_MODULE = 'C:\path\to\playwright\index.mjs'
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/karaoke-browser.mjs
# 배포 사이트 검사 시: KARAOKE_BASE_URL=https://dalatgolfvoucher.com/hana_karaoke
```

## 비파괴적 중단과 복구

1. 문제가 생기면 새 `hana-karaoke` Edge endpoint만 유지보수용 503 응답으로 비활성화하고, 정적 사이트 배포에서 karaoke 페이지와 해당 진입 링크만 제외합니다. 페이지를 숨기는 것만으로 API 호출이 중단되지는 않습니다.
2. 새 테이블과 마이그레이션 기록은 그대로 둡니다. 기존 업무 테이블/정책을 수정하거나, 프로젝트 전체 키를 회전하거나, 공유 Edge 함수를 중단하지 않습니다. 롤백에 `DROP TABLE`, 데이터 삭제, 마이그레이션 이력 삭제는 필요하지 않습니다.
3. 수정·검증 후 원래 karaoke Edge 소스와 정적 페이지를 다시 배포합니다. 재배포 시 `verify_jwt=false`와 서버 비밀값을 확인합니다. 공개 생성만 임시 중단할 때는 위 직원 전용 플래그를 사용할 수 있지만, 이는 기존 방/API 전체를 중단하는 스위치는 아닙니다.
