-- Independent administrator corrections preserve the original punches. A
-- missing endpoint may be supplied later or paired with the original records.
begin;
set local lock_timeout='5s';
lock table public.payroll_days in access exclusive mode nowait;

alter table public.payroll_days
  drop constraint payroll_days_check,
  add constraint payroll_days_partial_times_check check (
    (check_in is null or (isfinite(check_in) and check_in::date=work_date))
    and (check_out is null or (
      isfinite(check_out)
      and check_out>=work_date::timestamp
      and check_out<work_date::timestamp+interval '2 days'
    ))
    and (check_in is null or check_out is null or (
      check_out>check_in and check_out<=check_in+interval '24 hours'
    ))
  );

comment on constraint payroll_days_partial_times_check on public.payroll_days is
  'Each endpoint may be corrected independently. Check-in belongs to work_date; checkout may be on that day or the next. Complete pairs must be positive and at most 24 hours. Missing original counterparts remain incomplete in payroll calculations.';

-- Existing administrator policies, write/audit/revision triggers, immutable
-- employee/date keys and backup/restore validation remain unchanged.
commit;
