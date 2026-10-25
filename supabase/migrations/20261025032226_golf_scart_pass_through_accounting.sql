-- S-CART is one pass-through amount per reservation, not a per-player price.
-- Preserve the existing text/API contract and every actual payment record.
-- Existing completed S-CART was already paid out of the supplied current
-- course balances: correct its ledger cost and opening basis by the same delta.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.golf_scart_amount_vnd(p_note text)
returns bigint
language plpgsql
immutable
parallel safe
security invoker
set search_path = ''
as $$
declare
  v_text text := regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_amount numeric;
begin
  if v_text = '' then return 0; end if;
  if length(v_text) > 300
     or v_text !~* '^([0-9]+|[0-9]{1,3}(,[0-9]{3})+)([[:space:]]*VND)?$' then
    raise exception 'S-CART 금액을 올바른 정수로 입력해 주세요. / Vui lòng nhập số tiền S-CART nguyên hợp lệ.'
      using errcode = '23514';
  end if;
  v_amount := replace(regexp_replace(v_text, '[[:space:]]*VND$', '', 'i'), ',', '')::numeric;
  if v_amount > 1000000000 then
    raise exception 'S-CART는 0~1,000,000,000 VND로 입력해 주세요. / S-CART phải từ 0 đến 1.000.000.000 VND.'
      using errcode = '23514';
  end if;
  return v_amount::bigint;
end;
$$;
revoke all on function public.golf_scart_amount_vnd(text) from public, anon;
grant execute on function public.golf_scart_amount_vnd(text) to authenticated, service_role;
comment on function public.golf_scart_amount_vnd(text) is
  'Pure validated VND parser for the backward-compatible S-CART field; blank means no pass-through charge.';

-- Briefly freeze only golf ledgers while taking and checking the cutover
-- snapshot. Concurrent saves either finish before this lock or wait for commit.
lock table public.golf_reservations in access exclusive mode;
lock table public.golf_reservation_payments,
  public.golf_course_budget_accounts,
  public.golf_course_budget_deposits,
  public.golf_course_budget_reservation_charges,
  public.golf_partner_reservation_offsets in share row exclusive mode;

create temporary table scart_before_reservations on commit drop as
select r.id, to_jsonb(r) - 'guest_total_vnd' - 'course_total_vnd' as original_fields,
       r.guest_total_vnd, r.course_total_vnd,
       public.golf_scart_amount_vnd(r.smart_cart_note) as cart_vnd
from public.golf_reservations r;
create temporary table scart_before_payments on commit drop as
select id, to_jsonb(p) as original_fields from public.golf_reservation_payments p;
create temporary table scart_before_balances on commit drop as
select a.golf_course, a.opening_balance_vnd
  + coalesce((select sum(d.amount_vnd) from public.golf_course_budget_deposits d
              where d.golf_course = a.golf_course), 0)
  - coalesce((select sum(c.amount_vnd) from public.golf_course_budget_reservation_charges c
              where c.golf_course = a.golf_course and c.active), 0) as balance_vnd
from public.golf_course_budget_accounts a;

do $$
begin
  -- Do not conceal a pre-existing unrelated ledger discrepancy.
  if exists (
    select 1 from public.golf_reservations r
    join scart_before_reservations b on b.id = r.id
    left join public.golf_course_budget_reservation_charges c on c.reservation_id = r.id
    where b.cart_vnd > 0 and r.status = 'completed'
      and r.cost_settlement_type = 'golf_course'
      and r.golf_course in ('AT1200', 'SAM', 'PALACE')
      and (c.reservation_id is null or not c.active
           or c.golf_course is distinct from r.golf_course
           or c.amount_vnd is distinct from r.course_total_vnd)
  ) then
    raise exception 'S-CART migration stopped: reconcile the existing course ledger first';
  end if;
end;
$$;

-- PostgreSQL 17 rewrites the stored values without dropping dependent columns,
-- privileges or indexes. The existing completion/rerouting triggers continue
-- to use course_total_vnd, so future S-CART follows the selected cost recipient.
alter table public.golf_reservations
  alter column guest_total_vnd set expression as (
    case when guest_unit_price_vnd is null then null::bigint
      else guest_unit_price_vnd * pax + public.golf_scart_amount_vnd(smart_cart_note) end
  ),
  alter column course_total_vnd set expression as (
    case when course_unit_price_vnd is null then null::bigint
      else course_unit_price_vnd * pax + public.golf_scart_amount_vnd(smart_cart_note) end
  );

-- Validate even when both unit prices are unknown and CASE skips the parser.
alter table public.golf_reservations
  add constraint golf_reservations_scart_amount_check
  check (public.golf_scart_amount_vnd(smart_cart_note) between 0 and 1000000000);

create temporary table scart_course_adjustments on commit drop as
select c.reservation_id, c.golf_course, r.course_total_vnd as corrected_vnd,
       r.course_total_vnd - c.amount_vnd as delta_vnd
from public.golf_course_budget_reservation_charges c
join public.golf_reservations r on r.id = c.reservation_id
join scart_before_reservations b on b.id = r.id
where c.active and r.status = 'completed' and r.cost_settlement_type = 'golf_course'
  and b.cart_vnd > 0 and c.amount_vnd is distinct from r.course_total_vnd;

-- This is an opening-basis correction, NOT a new deposit/payment. Preserve
-- charged_at, historical and reversal timestamps on the original charge rows.
update public.golf_course_budget_accounts a
set opening_balance_vnd = a.opening_balance_vnd + adjustment.delta_vnd
from (select golf_course, sum(delta_vnd) as delta_vnd
      from scart_course_adjustments group by golf_course) adjustment
where a.golf_course = adjustment.golf_course;
update public.golf_course_budget_reservation_charges c
set amount_vnd = adjustment.corrected_vnd
from scart_course_adjustments adjustment
where c.reservation_id = adjustment.reservation_id;

-- Partner costs never touch a course wallet. Existing active offsets follow
-- the corrected total; there were no positive partner S-CART rows at cutover.
update public.golf_partner_reservation_offsets o
set amount_vnd = r.course_total_vnd
from public.golf_reservations r, scart_before_reservations b
where r.id = o.reservation_id and b.id = r.id and b.cart_vnd > 0
  and o.active and r.status = 'completed' and r.cost_settlement_type = 'partner'
  and o.amount_vnd is distinct from r.course_total_vnd;

-- Abort the entire migration if any protected value or current balance changed.
do $$
begin
  if exists (
    select 1 from scart_before_reservations b
    full join public.golf_reservations r on r.id = b.id
    where b.id is null or r.id is null
       or b.original_fields is distinct from (to_jsonb(r) - 'guest_total_vnd' - 'course_total_vnd')
       or r.guest_total_vnd is distinct from (b.guest_total_vnd + b.cart_vnd)
       or r.course_total_vnd is distinct from (b.course_total_vnd + b.cart_vnd)
  ) then
    raise exception 'S-CART migration stopped: reservation preservation check failed';
  end if;
  if exists (
    select 1 from scart_before_payments b
    full join public.golf_reservation_payments p on p.id = b.id
    where b.id is null or p.id is null or b.original_fields is distinct from to_jsonb(p)
  ) then
    raise exception 'S-CART migration stopped: actual payment records changed';
  end if;
  if exists (
    select 1 from scart_before_balances b
    full join public.golf_course_budget_accounts a on a.golf_course = b.golf_course
    where a.golf_course is null or b.golf_course is null or b.balance_vnd is distinct from (
      a.opening_balance_vnd
      + coalesce((select sum(d.amount_vnd) from public.golf_course_budget_deposits d
                  where d.golf_course = a.golf_course), 0)
      - coalesce((select sum(c.amount_vnd) from public.golf_course_budget_reservation_charges c
                  where c.golf_course = a.golf_course and c.active), 0)
    )
  ) then
    raise exception 'S-CART migration stopped: current course balance changed';
  end if;
end;
$$;

comment on column public.golf_reservations.smart_cart_note is
  'S-CART VND lump sum for this reservation. Blank/zero when guests pay the course directly. Added equally to customer total and the selected course/partner cost.';
comment on column public.golf_reservations.guest_total_vnd is
  'Guest unit price times PAX plus the reservation S-CART pass-through amount.';
comment on column public.golf_reservations.course_total_vnd is
  'Course/partner unit cost times PAX plus the same S-CART amount; not S-CART profit.';
analyze public.golf_reservations;
notify pgrst, 'reload schema';
commit;
