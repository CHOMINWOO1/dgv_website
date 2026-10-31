-- Allow a new Vietnam-calendar-day arrival after an older unclosed IN.
-- No raw attendance is edited or synthesized. Overnight OUT, per-request
-- idempotency, all-time prior-event snapshots and the existing cooldown remain.
-- CREATE OR REPLACE preserves the existing restricted owners and EXECUTE ACLs.
begin;

create or replace function payroll_kiosk.payroll_kiosk_touch_challenge(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid) returns jsonb
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
    -- A missed earlier-day checkout never blocks a deliberate new-day arrival.
    -- Compare raw Vietnam calendar dates, while retaining the all-time prior
    -- event for concurrency and preserving the 30-second cooldown below.
    if prior.punch_type=p_kind and not (p_kind='in' and
      prior.occurred_at::date<(v_now at time zone 'Asia/Ho_Chi_Minh')::date)
      then raise exception 'PAYROLL_KIOSK_SAME_DIRECTION';end if;
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

create or replace function payroll_kiosk.payroll_kiosk_touch_confirm(p_token text,p_challenge_id uuid,p_code text) returns jsonb
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
  elsif prior.punch_type=c.punch_type and not (c.punch_type='in' and prior.occurred_at::date<v_local::date)
    then v_error:='same_direction';
  elsif prior.occurred_at>v_local-interval '30 seconds' then v_error:='cooldown';end if;
  if v_error is not null then return jsonb_build_object('ok',false,'error',v_error,'attempts_remaining',greatest(0,5-c.attempts));end if;
  if exists(select 1 from public.payroll_attendance_raw where kiosk_request_id=c.request_id) then raise exception 'PAYROLL_KIOSK_REQUEST_CONFLICT';end if;
  insert into public.payroll_attendance_raw(employee_id,occurred_at,device_id,import_id,source,punch_type,kiosk_device_id,kiosk_request_id,created_by,created_at,verification_method)
    values(c.employee_id,v_local,'kiosk:'||d.id::text,null,'kiosk',c.punch_type,d.id,c.request_id,d.created_by,v_now,'visible_code_confirmation') returning * into r;
  update payroll_kiosk.payroll_kiosk_touch_challenges set consumed_at=v_now,event_id=r.id where id=c.id returning * into c;
  return jsonb_build_object('ok',true,'event',payroll_kiosk.payroll_kiosk_touch_event(c,false));
end;$$;

create or replace function payroll_kiosk.payroll_kiosk_roster(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;v_employees jsonb;v_now timestamptz;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  v_now:=clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'device_user_id',e.device_user_id,'name',e.name,'enrollment_id',g.id,
    'has_legacy_enrollment',exists(select 1 from payroll_kiosk.payroll_kiosk_enrollments l where l.employee_id=e.id and l.revoked_at is null),
    'face_registered',f.revision is not null and f.deleted_at is null,'face_revision',coalesce(f.revision,0),
    'last_punch',(select jsonb_build_object('punch_type',r.punch_type,'occurred_at',r.occurred_at) from public.payroll_attendance_raw r
      where r.employee_id=e.id and r.punch_type is not null order by r.occurred_at desc,r.id desc limit 1)) order by e.name,e.id),'[]'::jsonb)
    into v_employees from public.payroll_employees e
    left join payroll_kiosk.payroll_kiosk_enrollments g on g.employee_id=e.id and g.device_id=d.id and g.revoked_at is null
    left join payroll_kiosk.payroll_kiosk_faces f on f.employee_id=e.id
    where payroll_kiosk.payroll_kiosk_employee_eligible(e.id);
  return jsonb_build_object('device_id',d.id,'name',d.name,'employees',v_employees,
    'server_time',v_now,'server_date',(v_now at time zone 'Asia/Ho_Chi_Minh')::date);
end;$$;

notify pgrst,'reload schema';
commit;
