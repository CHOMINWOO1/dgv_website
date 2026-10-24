-- Keep historical audit fields stable while aligning the counterparty category rule.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.golf_reservations
  disable trigger golf_reservations_touch_audit;

update public.golf_reservations
set customer_type = case
  when lower(btrim(counterparty_name)) = 'sếp'
    or upper(btrim(counterparty_name)) = 'SEP'
    then 'individual'
  else 'company'
end
where customer_type is distinct from case
  when lower(btrim(counterparty_name)) = 'sếp'
    or upper(btrim(counterparty_name)) = 'SEP'
    then 'individual'
  else 'company'
end;

alter table public.golf_reservations
  enable trigger golf_reservations_touch_audit;

commit;
