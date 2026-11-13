-- Hosted migration version: 20261113113647.
-- Missing hire dates must be supplied explicitly by the administrator.
-- Existing dates, payment history, RLS and atomic conversion behavior are preserved.
set local lock_timeout='3s';
CREATE OR REPLACE FUNCTION public.payroll_conversion_candidate(p_employee_id uuid, p_repair boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare e public.payroll_employees;t public.payroll_terms;a jsonb;original_date date;prior_type text;
begin
 perform public.payroll_assert_admin();
 select * into strict e from public.payroll_employees where id=p_employee_id;
 if e.archived_at is not null or e.payee_type<>'employee' or e.employment_status<>'active' then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 
 original_date:=e.hire_date;prior_type:=e.employment_type;
 if p_repair then
  if e.employment_type<>'full_time' then raise exception 'PAYROLL_CONVERSION_REPAIR_UNAVAILABLE';end if;
  select before_data into a from public.payroll_audit where table_name='payroll_employees' and record_id=e.id
   and before_data->>'employment_type'='part_time' and after_data->>'employment_type'='full_time'
   and after_data->>'hire_date'=e.hire_date::text order by created_at desc limit 1;
  if a is null then raise exception 'PAYROLL_CONVERSION_PART_TIME_REQUIRED';end if;
  original_date:=(a->>'hire_date')::date;prior_type:='part_time';
 end if;
 if p_repair and original_date is null then raise exception 'PAYROLL_CONVERSION_HIRE_DATE_REQUIRED';end if;
 select * into t from public.payroll_terms where employee_id=e.id order by effective_from desc limit 1;
 return jsonb_build_object('employee_id',e.id,'name',e.name,'original_hire_date',original_date,'prior_employment_type',prior_type,
  'repair',p_repair,'term',to_jsonb(t));
end $function$
;

CREATE OR REPLACE FUNCTION public.payroll_convert_employment(p_employee_id uuid, p_employment_type text, p_terms jsonb, p_prior_salary_amount bigint, p_reason text, p_expected_revision bigint, p_request_id uuid, p_repair boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare candidate jsonb;e public.payroll_employees;term public.payroll_terms;saved public.payroll_employment_conversions;
 v_revision bigint;start_date date;original_date date;payload jsonb;term_id uuid;conversion_id uuid;key text;
begin
 perform public.payroll_assert_admin();
 if p_employment_type is null or p_employment_type not in ('part_time','full_time') or p_request_id is null or p_expected_revision is null or p_repair is null or jsonb_typeof(p_terms) is distinct from 'object'
  or (p_prior_salary_amount is not null and p_prior_salary_amount not between 0 and 1000000000) or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 payload:=jsonb_build_object('employee_id',p_employee_id,'employment_type',p_employment_type,'terms',p_terms,'prior_salary_amount',p_prior_salary_amount,'reason',btrim(p_reason),'repair',p_repair);
 select version into v_revision from public.payroll_revision where id=1 for update;
 select * into saved from public.payroll_employment_conversions where request_id=p_request_id;
 if found then if saved.request_payload<>payload then raise exception 'PAYROLL_CONVERSION_REQUEST_CONFLICT';end if;return saved.id;end if;
 if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';end if;
 for key in select jsonb_object_keys(p_terms) loop
  if key not in ('effective_from','rate','shift_start','shift_end','break_start','break_end','weekly_rest_day','original_hire_date') then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 end loop;
 if jsonb_typeof(p_terms->'rate') is distinct from 'number' or (p_terms->>'rate') !~ '^[0-9]{1,10}$'
  or jsonb_typeof(p_terms->'weekly_rest_day') is distinct from 'number' then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 candidate:=public.payroll_conversion_candidate(p_employee_id,p_repair);
 if candidate->>'prior_employment_type'=p_employment_type then raise exception 'PAYROLL_CONVERSION_SAME_TYPE';end if;
 if (candidate->>'repair')::boolean is distinct from p_repair then raise exception 'PAYROLL_CONVERSION_STATE_CHANGED';end if;
 original_date:=(candidate->>'original_hire_date')::date;
 if p_terms ? 'original_hire_date' and (jsonb_typeof(p_terms->'original_hire_date') is distinct from 'string' or (original_date is not null and original_date is distinct from (p_terms->>'original_hire_date')::date)) then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 if original_date is null then original_date:=(p_terms->>'original_hire_date')::date;end if;
 if original_date is null or not isfinite(original_date) then raise exception 'PAYROLL_CONVERSION_HIRE_DATE_REQUIRED';end if;
 start_date:=(p_terms->>'effective_from')::date;
 if start_date is null or not isfinite(start_date) or start_date<original_date or start_date>(now() at time zone 'Asia/Ho_Chi_Minh')::date
  or (p_terms->>'rate')::bigint not between (case when p_employment_type='part_time' then 1 else 0 end) and 1000000000 or (p_terms->>'weekly_rest_day')::integer not between 0 and 6 then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 if exists(select 1 from public.payroll_employment_conversions where employee_id=p_employee_id and effective_from>=start_date) then raise exception 'PAYROLL_CONVERSION_LATER_CHANGE';end if;
 if start_date=greatest(original_date,date_trunc('month',start_date)::date) and coalesce(p_prior_salary_amount,0)<>0 then raise exception 'PAYROLL_CONVERSION_NO_PRIOR_PERIOD';end if;
 if exists(select 1 from public.payroll_runs where employee_id=p_employee_id and month>=date_trunc('month',start_date)::date) then raise exception 'PAYROLL_CONVERSION_FINALIZED';end if;
 select * into e from public.payroll_employees where id=p_employee_id for update;
 if exists(select 1 from public.payroll_terms where employee_id=e.id and effective_from>start_date) then raise exception 'PAYROLL_CONVERSION_LATER_TERMS';end if;
 select * into term from public.payroll_terms where employee_id=e.id and effective_from=start_date;
 if found then
  if not p_repair or term.pay_type<>'monthly' or term.monthly_settlement<>'monthly_net' or term.rate<>(p_terms->>'rate')::bigint
   or term.shift_start<>(p_terms->>'shift_start')::time or term.shift_end<>(p_terms->>'shift_end')::time
   or term.break_start<>(p_terms->>'break_start')::time or term.break_end<>(p_terms->>'break_end')::time
   or term.weekly_rest_day<>(p_terms->>'weekly_rest_day')::integer then raise exception 'PAYROLL_CONVERSION_TERMS_CONFLICT';end if;
  term_id:=term.id;
 else
  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement,shift_start,shift_end,break_start,break_end,weekly_rest_day)
   values(e.id,start_date,case when p_employment_type='full_time' then 'monthly' else 'hourly' end,(p_terms->>'rate')::bigint,case when p_employment_type='full_time' then 'monthly_net' else 'statutory' end,(p_terms->>'shift_start')::time,(p_terms->>'shift_end')::time,(p_terms->>'break_start')::time,(p_terms->>'break_end')::time,(p_terms->>'weekly_rest_day')::integer) returning id into term_id;
 end if;
 update public.payroll_employees set employment_type=p_employment_type,hire_date=original_date where id=e.id;
 insert into public.payroll_employment_conversions(employee_id,effective_from,original_hire_date,prior_employment_type,employment_type,prior_salary_amount,term_id,reason,request_id,request_payload)
  values(e.id,start_date,original_date,candidate->>'prior_employment_type',p_employment_type,p_prior_salary_amount,term_id,btrim(p_reason),p_request_id,payload) returning id into conversion_id;
 return conversion_id;
end $function$
;
revoke all on function public.payroll_conversion_candidate(uuid,boolean) from public,anon;
grant execute on function public.payroll_conversion_candidate(uuid,boolean) to authenticated;
revoke all on function public.payroll_convert_employment(uuid,text,jsonb,bigint,text,bigint,uuid,boolean) from public,anon;
grant execute on function public.payroll_convert_employment(uuid,text,jsonb,bigint,text,bigint,uuid,boolean) to authenticated;
