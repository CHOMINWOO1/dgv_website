-- ISOLATED POSTGRES/PGlite ONLY. Never run this fixture on production.
-- Each request uses the real kiosk RPC and its server clock. Between requests,
-- the test owner moves only this transaction's synthetic employee records back
-- by one minute to exercise the existing 30-second cooldown without real sleeps.
-- Trigger suspension and every synthetic row are rolled back at the end.
begin;
create function pg_temp.kiosk_multi_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare
  actor uuid:='00000000-0000-4000-8000-000000000009';
  employee uuid:=gen_random_uuid();device uuid:=gen_random_uuid();
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  request_ids uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  directions text[]:=array['in','out','in','out'];
  event_ids uuid[]:=array[]::uuid[];event jsonb;receipt jsonb;
  first_day date;local_now timestamp;revision bigint;i integer;rejected boolean;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(id,device_user_id,name) values(employee,'TWO-CYCLES-'||employee,'Synthetic two shifts');
  perform public.payroll_kiosk_register(device,'Synthetic split-shift tablet',token);
  perform public.payroll_kiosk_enroll(device,employee,'local-face-consent-v1');
  select version into revision from public.payroll_revision where id=1;
  perform set_config('request.jwt.claims','{}',true);

  for i in 1..4 loop
    execute 'set local role anon';
    event:=public.payroll_kiosk_punch(token,employee,directions[i],request_ids[i]);
    local_now:=clock_timestamp() at time zone 'Asia/Ho_Chi_Minh';
    if first_day is null then first_day:=(event->>'occurred_at')::timestamp::date;end if;
    perform pg_temp.kiosk_multi_assert(event->>'punch_type'=directions[i] and not (event->>'replayed')::boolean,
      'both same-day shifts accept each new alternating direction');
    perform pg_temp.kiosk_multi_assert((event->>'occurred_at')::timestamp::date=first_day
      and abs(extract(epoch from local_now-(event->>'occurred_at')::timestamp))<5,
      'both cycles return the same server-local calendar day without client timestamps');
    event_ids:=array_append(event_ids,(event->>'event_id')::uuid);
    perform pg_temp.kiosk_multi_assert(public.payroll_kiosk_roster(token)->'employees'->0->'last_punch'->>'punch_type'=directions[i],
      'roster state follows each return to work and departure');
    if i<4 then
      execute 'set local role postgres';
      set constraints public.payroll_attendance_raw_import_id_fkey immediate;
      alter table public.payroll_attendance_raw disable trigger user;
      update public.payroll_attendance_raw set occurred_at=occurred_at-interval '1 minute' where employee_id=employee;
      alter table public.payroll_attendance_raw enable trigger user;
    end if;
  end loop;

  receipt:=public.payroll_kiosk_punch(token,employee,'out',request_ids[4]);
  perform pg_temp.kiosk_multi_assert(receipt-'replayed'=event-'replayed' and (receipt->>'replayed')::boolean,
    'second-shift departure retry returns the same event');
  perform pg_temp.kiosk_multi_assert(public.payroll_kiosk_receipt(token,request_ids[4])=receipt,
    'receipt recovery works after the second shift');
  rejected:=false;
  begin perform public.payroll_kiosk_punch(token,employee,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_SAME_DIRECTION';end;
  perform pg_temp.kiosk_multi_assert(rejected,'a duplicate departure remains rejected');
  rejected:=false;
  begin perform public.payroll_kiosk_punch(token,employee,'in',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_COOLDOWN';end;
  perform pg_temp.kiosk_multi_assert(rejected,'multiple shifts do not bypass the rapid-repeat cooldown');
  execute 'set local role postgres';
  perform pg_temp.kiosk_multi_assert((select count(*)=4 from public.payroll_attendance_raw where employee_id=employee)
    and cardinality(event_ids)=4 and (select count(distinct value)=4 from unnest(event_ids) as value),
    'exactly four independent raw records remain for two shifts');
  perform pg_temp.kiosk_multi_assert((select array_agg(punch_type order by occurred_at,id)=directions from public.payroll_attendance_raw where employee_id=employee),
    'stored directions retain two ordered work pairs');
  perform pg_temp.kiosk_multi_assert((select version=revision+4 from public.payroll_revision where id=1),
    'each new punch advances revision once; retries and rejections do not');
  perform pg_temp.kiosk_multi_assert((select count(*)=4 from public.payroll_audit where record_id=any(event_ids)),
    'both work cycles keep their audit records');
end;$$;
rollback;
