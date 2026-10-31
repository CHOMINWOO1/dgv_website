-- Visible random digits confirm a deliberate tap; they are not an employee PIN
-- or proof of identity. Registered-device capability is the authority boundary.
-- Existing face endpoints and existing attendance rows are unchanged.
begin;
alter table public.payroll_attendance_raw add column verification_method text,
  add constraint payroll_attendance_verification_method_check check(verification_method is null or
    (source='kiosk' and verification_method='visible_code_confirmation'));
create table payroll_kiosk.payroll_kiosk_touch_challenges (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  device_id uuid not null,
  employee_id uuid not null,
  punch_type text not null check(punch_type in ('in','out')),
  code text not null check(code~'^[0-9]{4}$'),
  prior_event_id uuid,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check(attempts between 0 and 5),
  consumed_at timestamptz,
  event_id uuid unique,
  cancelled_at timestamptz,
  closed_reason text check(closed_reason in ('cancelled','superseded','stale_state','employee_not_active')),
  check(isfinite(created_at) and isfinite(expires_at) and expires_at=created_at+interval '120 seconds'),
  check((consumed_at is null and event_id is null) or (consumed_at is not null and event_id is not null and cancelled_at is null)),
  check((cancelled_at is null and closed_reason is null) or (cancelled_at is not null and closed_reason is not null and consumed_at is null))
);
create unique index payroll_kiosk_touch_active_device_idx on payroll_kiosk.payroll_kiosk_touch_challenges(device_id)
  where consumed_at is null and cancelled_at is null and attempts<5;
create index payroll_kiosk_touch_employee_idx on payroll_kiosk.payroll_kiosk_touch_challenges(employee_id);
create index payroll_kiosk_touch_device_created_idx on payroll_kiosk.payroll_kiosk_touch_challenges(device_id,created_at desc,id desc);
-- These are historical identifiers, with no FK to employee/device/raw tables.
-- Every issuing/confirming RPC validates its live device and employee. Owner
-- cleanup or ordinary backup/restore is not blocked by expired confirmations;
-- consumed requests still cannot be reused, and removed devices remain denied.
alter table payroll_kiosk.payroll_kiosk_touch_challenges enable row level security;
revoke all on payroll_kiosk.payroll_kiosk_touch_challenges from public,anon,authenticated,service_role;
grant select,insert,update on payroll_kiosk.payroll_kiosk_touch_challenges to payroll_kiosk_writer;
create policy payroll_kiosk_touch_writer_read on payroll_kiosk.payroll_kiosk_touch_challenges for select to payroll_kiosk_writer using(true);
create policy payroll_kiosk_touch_writer_insert on payroll_kiosk.payroll_kiosk_touch_challenges for insert to payroll_kiosk_writer with check(true);
create policy payroll_kiosk_touch_writer_update on payroll_kiosk.payroll_kiosk_touch_challenges for update to payroll_kiosk_writer using(true) with check(true);

create function payroll_kiosk.payroll_kiosk_touch_event(p_challenge payroll_kiosk.payroll_kiosk_touch_challenges,p_replayed boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$declare r public.payroll_attendance_raw%rowtype;begin
  select * into r from public.payroll_attendance_raw where id=p_challenge.event_id
    and kiosk_request_id=p_challenge.request_id and kiosk_device_id=p_challenge.device_id
    and employee_id=p_challenge.employee_id and punch_type=p_challenge.punch_type
    and verification_method='visible_code_confirmation';
  if not found then return null;end if;
  return payroll_kiosk.payroll_kiosk_event_json(r,p_replayed)||jsonb_build_object('verification','visible_code_confirmation');
end;$$;
create function payroll_kiosk.payroll_kiosk_touch_challenge_json(p_challenge payroll_kiosk.payroll_kiosk_touch_challenges) returns jsonb
language plpgsql security invoker set search_path='' as $$declare v_status text;v_event jsonb;begin
  if p_challenge.consumed_at is not null then
    v_event:=payroll_kiosk.payroll_kiosk_touch_event(p_challenge,true);
    if v_event is not null then return jsonb_build_object('status','completed','event',v_event);end if;
    v_status:='cancelled';
  elsif p_challenge.cancelled_at is not null then
    v_status:=case when p_challenge.closed_reason='stale_state' then 'stale_state' else 'cancelled' end;
  elsif p_challenge.attempts>=5 then v_status:='locked';
  elsif clock_timestamp()>=p_challenge.expires_at then v_status:='expired';
  else v_status:='pending';end if;
  return jsonb_build_object('status',v_status,'challenge_id',p_challenge.id,'request_id',p_challenge.request_id,
    'employee_id',p_challenge.employee_id,'punch_type',p_challenge.punch_type,'code',case when v_status='pending' then p_challenge.code else null end,
    'expires_at',p_challenge.expires_at,'server_time',clock_timestamp(),'attempts_remaining',greatest(0,5-p_challenge.attempts));
end;$$;

create function payroll_kiosk.payroll_kiosk_touch_challenge(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;c payroll_kiosk.payroll_kiosk_touch_challenges%rowtype;
  prior public.payroll_attendance_raw%rowtype;v_now timestamptz;v_code text;last_code text;random_bytes bytea;random_value integer;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  if p_employee_id is null or p_request_id is null or p_kind is null or p_kind not in ('in','out') then raise exception 'PAYROLL_KIOSK_INVALID_PUNCH';end if;
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select * into c from payroll_kiosk.payroll_kiosk_touch_challenges where request_id=p_request_id;
  if found then
    if c.device_id<>d.id or c.employee_id<>p_employee_id or c.punch_type<>p_kind then raise exception 'PAYROLL_KIOSK_REQUEST_CONFLICT';end if;
    if c.consumed_at is null and c.cancelled_at is null then
      select * into prior from public.payroll_attendance_raw where employee_id=p_employee_id and punch_type is not null order by occurred_at desc,id desc limit 1;
      if prior.id is distinct from c.prior_event_id then
        update payroll_kiosk.payroll_kiosk_touch_challenges set cancelled_at=clock_timestamp(),closed_reason='stale_state' where id=c.id returning * into c;
      elsif not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then
        update payroll_kiosk.payroll_kiosk_touch_challenges set cancelled_at=clock_timestamp(),closed_reason='employee_not_active' where id=c.id returning * into c;
      end if;
    end if;
    return payroll_kiosk.payroll_kiosk_touch_challenge_json(c);
  end if;
  if exists(select 1 from public.payroll_attendance_raw where kiosk_request_id=p_request_id) then raise exception 'PAYROLL_KIOSK_REQUEST_CONFLICT';end if;
  if not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  v_now:=clock_timestamp();
  select * into prior from public.payroll_attendance_raw where employee_id=p_employee_id and punch_type is not null order by occurred_at desc,id desc limit 1;
  if not found then
    if p_kind='out' then raise exception 'PAYROLL_KIOSK_CHECK_IN_REQUIRED';end if;
  else
    if prior.punch_type=p_kind then raise exception 'PAYROLL_KIOSK_SAME_DIRECTION';end if;
    if prior.occurred_at>(v_now at time zone 'Asia/Ho_Chi_Minh')-interval '30 seconds' then raise exception 'PAYROLL_KIOSK_COOLDOWN';end if;
  end if;
  select code into last_code from payroll_kiosk.payroll_kiosk_touch_challenges where device_id=d.id order by created_at desc,id desc limit 1;
  -- The first UUID bytes are cryptographically random (outside its version bits).
  -- Rejection of 60000..65535 avoids modulo bias, including zero-padded codes.
  loop
    random_bytes:=uuid_send(gen_random_uuid());random_value:=get_byte(random_bytes,0)*256+get_byte(random_bytes,1);
    if random_value<60000 then
      v_code:=lpad((random_value%10000)::text,4,'0');
      exit when v_code is distinct from last_code;
    end if;
  end loop;
  update payroll_kiosk.payroll_kiosk_touch_challenges set cancelled_at=v_now,closed_reason='superseded'
    where device_id=d.id and consumed_at is null and cancelled_at is null;
  insert into payroll_kiosk.payroll_kiosk_touch_challenges(request_id,device_id,employee_id,punch_type,code,prior_event_id,created_at,expires_at)
    values(p_request_id,d.id,p_employee_id,p_kind,v_code,prior.id,v_now,v_now+interval '120 seconds') returning * into c;
  return payroll_kiosk.payroll_kiosk_touch_challenge_json(c);
end;$$;

create function payroll_kiosk.payroll_kiosk_touch_confirm(p_token text,p_challenge_id uuid,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;c payroll_kiosk.payroll_kiosk_touch_challenges%rowtype;
  prior public.payroll_attendance_raw%rowtype;r public.payroll_attendance_raw%rowtype;v_now timestamptz;v_local timestamp;v_event jsonb;v_error text;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  if p_challenge_id is null then raise exception 'PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND';end if;
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select * into c from payroll_kiosk.payroll_kiosk_touch_challenges where id=p_challenge_id and device_id=d.id for update;
  if not found then raise exception 'PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND';end if;
  if c.consumed_at is not null then
    if p_code is distinct from c.code then return jsonb_build_object('ok',false,'error','code_mismatch','attempts_remaining',0);end if;
    v_event:=payroll_kiosk.payroll_kiosk_touch_event(c,true);
    if v_event is null then return jsonb_build_object('ok',false,'error','record_unavailable','attempts_remaining',0);end if;
    return jsonb_build_object('ok',true,'event',v_event);
  end if;
  if c.cancelled_at is not null then return jsonb_build_object('ok',false,'error',case when c.closed_reason='stale_state' then 'stale_state' else 'cancelled' end,'attempts_remaining',0);end if;
  if c.attempts>=5 then return jsonb_build_object('ok',false,'error','locked','attempts_remaining',0);end if;
  v_now:=clock_timestamp();
  if v_now>=c.expires_at then return jsonb_build_object('ok',false,'error','expired','attempts_remaining',greatest(0,5-c.attempts));end if;
  if p_code is null or p_code!~'^[0-9]{4}$' or p_code<>c.code then
    update payroll_kiosk.payroll_kiosk_touch_challenges set attempts=attempts+1 where id=c.id returning * into c;
    -- Return normally so the failed attempt remains committed.
    return jsonb_build_object('ok',false,'error',case when c.attempts>=5 then 'locked' else 'code_mismatch' end,'attempts_remaining',greatest(0,5-c.attempts));
  end if;
  if not payroll_kiosk.payroll_kiosk_employee_eligible(c.employee_id) then
    update payroll_kiosk.payroll_kiosk_touch_challenges set cancelled_at=v_now,closed_reason='employee_not_active' where id=c.id;
    return jsonb_build_object('ok',false,'error','employee_not_active','attempts_remaining',0);
  end if;
  select * into prior from public.payroll_attendance_raw where employee_id=c.employee_id and punch_type is not null order by occurred_at desc,id desc limit 1;
  if prior.id is distinct from c.prior_event_id then
    update payroll_kiosk.payroll_kiosk_touch_challenges set cancelled_at=v_now,closed_reason='stale_state' where id=c.id;
    return jsonb_build_object('ok',false,'error','stale_state','attempts_remaining',0);
  end if;
  v_local:=v_now at time zone 'Asia/Ho_Chi_Minh';
  if prior.id is null and c.punch_type='out' then v_error:='check_in_required';
  elsif prior.punch_type=c.punch_type then v_error:='same_direction';
  elsif prior.occurred_at>v_local-interval '30 seconds' then v_error:='cooldown';end if;
  if v_error is not null then return jsonb_build_object('ok',false,'error',v_error,'attempts_remaining',greatest(0,5-c.attempts));end if;
  if exists(select 1 from public.payroll_attendance_raw where kiosk_request_id=c.request_id) then raise exception 'PAYROLL_KIOSK_REQUEST_CONFLICT';end if;
  insert into public.payroll_attendance_raw(employee_id,occurred_at,device_id,import_id,source,punch_type,kiosk_device_id,kiosk_request_id,created_by,created_at,verification_method)
    values(c.employee_id,v_local,'kiosk:'||d.id::text,null,'kiosk',c.punch_type,d.id,c.request_id,d.created_by,v_now,'visible_code_confirmation') returning * into r;
  update payroll_kiosk.payroll_kiosk_touch_challenges set consumed_at=v_now,event_id=r.id where id=c.id returning * into c;
  return jsonb_build_object('ok',true,'event',payroll_kiosk.payroll_kiosk_touch_event(c,false));
end;$$;

-- Resolving an unknown confirmation is atomic: committed event or cancellation.
-- A confirm already running finishes before this lock; a later confirm sees the
-- tombstone and cannot write a delayed event after a definitive not_saved result.
create function payroll_kiosk.payroll_kiosk_touch_resolve(p_device_id uuid,p_request_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c payroll_kiosk.payroll_kiosk_touch_challenges%rowtype;v_event jsonb;
begin
  perform version from public.payroll_revision where id=1 for update;
  select * into c from payroll_kiosk.payroll_kiosk_touch_challenges where device_id=p_device_id and request_id=p_request_id for update;
  if not found then raise exception 'PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND';end if;
  if c.consumed_at is not null then
    v_event:=payroll_kiosk.payroll_kiosk_touch_event(c,true);
    if v_event is not null then return jsonb_build_object('status','saved','event',v_event);end if;
    return jsonb_build_object('status','not_saved','reason','record_unavailable');
  end if;
  if c.cancelled_at is null then
    update payroll_kiosk.payroll_kiosk_touch_challenges set cancelled_at=clock_timestamp(),closed_reason='cancelled' where id=c.id;
  end if;
  return jsonb_build_object('status','not_saved');
end;$$;
create function payroll_kiosk.payroll_kiosk_touch_receipt(p_token text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare d payroll_kiosk.payroll_kiosk_devices%rowtype;begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  return payroll_kiosk.payroll_kiosk_touch_resolve(d.id,p_request_id);
end;$$;
create function payroll_kiosk.payroll_kiosk_touch_admin_receipt(p_device_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
  perform public.payroll_assert_admin();
  return payroll_kiosk.payroll_kiosk_touch_resolve(p_device_id,p_request_id);
end;$$;

grant create on schema payroll_kiosk to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_touch_challenge(text,uuid,text,uuid) owner to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_touch_confirm(text,uuid,text) owner to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_touch_receipt(text,uuid) owner to payroll_kiosk_writer;
revoke create on schema payroll_kiosk from payroll_kiosk_writer;
create function public.payroll_kiosk_touch_challenge(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_touch_challenge(p_token,p_employee_id,p_kind,p_request_id);$$;
create function public.payroll_kiosk_touch_confirm(p_token text,p_challenge_id uuid,p_code text) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_touch_confirm(p_token,p_challenge_id,p_code);$$;
create function public.payroll_kiosk_touch_receipt(p_token text,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_touch_receipt(p_token,p_request_id);$$;
create function public.payroll_kiosk_touch_admin_receipt(p_device_id uuid,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_touch_admin_receipt(p_device_id,p_request_id);$$;
do $$declare f record;begin
  for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','payroll_kiosk') and p.proname like 'payroll_kiosk_touch_%' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,payroll_kiosk_writer',f.signature);
    if f.proname in ('payroll_kiosk_touch_challenge','payroll_kiosk_touch_confirm','payroll_kiosk_touch_receipt') then
      execute format('grant execute on function %s to anon,authenticated',f.signature);
    elsif f.proname='payroll_kiosk_touch_admin_receipt' then
      execute format('grant execute on function %s to authenticated',f.signature);
    else execute format('grant execute on function %s to payroll_kiosk_writer',f.signature);end if;
  end loop;
end;$$;
comment on column public.payroll_attendance_raw.verification_method is 'NULL retains prior import/face-kiosk behavior; visible_code_confirmation records a camera-free screen confirmation, not employee identity authentication.';
comment on table payroll_kiosk.payroll_kiosk_touch_challenges is 'Private one-use visible confirmation codes, not employee PINs. 120-second expiry, five wrong entries, one pending challenge per device, exact request binding, attendance-state snapshot, and atomic resolve-or-cancel.';
notify pgrst,'reload schema';
commit;
