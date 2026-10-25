-- Rollback-only trigger integration test. Run the WHOLE file as postgres.
-- No fixture insert and no actual payment write; all changes roll back.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare
  r public.golf_reservations%rowtype;
  test_id uuid;
  guest_base bigint;
  course_base bigint;
  test_pax integer;
  n bigint;
  amount bigint;
  payments_before jsonb;
  account_before jsonb;
  bad text;
  rejected boolean;
begin
  select gr.* into r from public.golf_reservations gr
  where gr.status = 'in_progress' and gr.cost_settlement_type = 'golf_course'
    and gr.golf_course in ('AT1200', 'SAM', 'PALACE')
    and public.golf_scart_amount_vnd(gr.smart_cart_note) = 400000
    and gr.guest_unit_price_vnd is not null and gr.course_unit_price_vnd is not null
    and not exists (select 1 from public.golf_course_budget_reservation_charges c where c.reservation_id = gr.id)
    and not exists (select 1 from public.golf_partner_reservation_offsets o where o.reservation_id = gr.id)
  order by gr.golf_date, gr.id limit 1 for update of gr nowait;
  if not found then raise exception 'No suitable uncharged in-progress 400,000 VND S-CART reservation; aborted'; end if;
  test_id := r.id;
  test_pax := greatest(r.pax, 2);
  guest_base := r.guest_unit_price_vnd * test_pax;
  course_base := r.course_unit_price_vnd * test_pax;
  perform 1 from public.golf_reservation_payments p where p.reservation_id = test_id for update;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb) into payments_before
  from public.golf_reservation_payments p where p.reservation_id = test_id;
  select to_jsonb(a) into account_before from public.golf_course_budget_accounts a where a.golf_course = r.golf_course;
  if account_before is null then raise exception 'Missing budget account; aborted'; end if;

  if public.golf_scart_amount_vnd(null) <> 0 or public.golf_scart_amount_vnd('') <> 0
     or public.golf_scart_amount_vnd('   ') <> 0 or public.golf_scart_amount_vnd('0') <> 0
     or public.golf_scart_amount_vnd('400000') <> 400000
     or public.golf_scart_amount_vnd(' 400,000 vnd ') <> 400000
     or public.golf_scart_amount_vnd('1,000,000,000 VND') <> 1000000000 then
    raise exception 'Valid parser cases failed'; end if;
  foreach bad in array array['-1', '1.5', '400 / 000vnd', '400,00', '400k', 'NaN', '1000000001', repeat('1',301)] loop
    rejected := false;
    begin perform public.golf_scart_amount_vnd(bad);
    exception when check_violation then rejected := true; end;
    if not rejected then raise exception 'Invalid parser input accepted: %', bad; end if;
  end loop;

  -- NULL is the existing database representation of an empty input.
  update public.golf_reservations set pax = test_pax, smart_cart_note = null where id = test_id;
  select * into r from public.golf_reservations where id = test_id;
  if r.guest_total_vnd is distinct from guest_base or r.course_total_vnd is distinct from course_base then
    raise exception 'Blank total case failed'; end if;
  update public.golf_reservations set smart_cart_note = '0' where id = test_id;
  select * into r from public.golf_reservations where id = test_id;
  if r.guest_total_vnd is distinct from guest_base or r.course_total_vnd is distinct from course_base then
    raise exception 'Zero total case failed'; end if;
  update public.golf_reservations set smart_cart_note = '400,000 VND' where id = test_id;
  select * into r from public.golf_reservations where id = test_id;
  if r.guest_total_vnd is distinct from guest_base + 400000
     or r.course_total_vnd is distinct from course_base + 400000
     or r.guest_total_vnd - r.course_total_vnd is distinct from guest_base - course_base then
    raise exception 'Cart must be added once per reservation without increasing quoted profit'; end if;
  rejected := false;
  begin update public.golf_reservations set smart_cart_note = '400k' where id = test_id;
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'Invalid table write accepted'; end if;

  -- Status updates exercise existing triggers without fabricating payments.
  update public.golf_reservations
  set final_received_amount_vnd = greatest(guest_total_vnd, deposit_amount_vnd),
      final_received_date = greatest(golf_date, deposit_received_date) where id = test_id;
  select count(*), max(amount_vnd) into n, amount from public.golf_course_budget_reservation_charges
  where reservation_id = test_id and active;
  if n <> 1 or amount is distinct from course_base + 400000 then raise exception 'Completion single-charge failed'; end if;
  update public.golf_reservations set final_received_date = final_received_date where id = test_id;
  update public.golf_reservations set smart_cart_note = '500000' where id = test_id;
  select count(*), max(amount_vnd) into n, amount from public.golf_course_budget_reservation_charges
  where reservation_id = test_id and active;
  if n <> 1 or amount is distinct from course_base + 500000 then raise exception 'Repeated completion/cost edit failed'; end if;

  update public.golf_reservations set final_received_amount_vnd = null, final_received_date = null where id = test_id;
  if exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = test_id and active)
     or not exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = test_id and not active and reversed_at is not null) then
    raise exception 'Reopening reversal failed'; end if;
  update public.golf_reservations
  set final_received_amount_vnd = greatest(guest_total_vnd, deposit_amount_vnd),
      final_received_date = greatest(golf_date, deposit_received_date) where id = test_id;
  select count(*), max(amount_vnd) into n, amount from public.golf_course_budget_reservation_charges
  where reservation_id = test_id and active and reversed_at is null;
  if n <> 1 or amount is distinct from course_base + 500000 then raise exception 'Recompletion single-charge failed'; end if;

  update public.golf_reservations set cost_settlement_type = 'partner', cost_partner_name = 'Chị Oanh' where id = test_id;
  select count(*), max(amount_vnd) into n, amount from public.golf_partner_reservation_offsets
  where reservation_id = test_id and partner_name = 'Chị Oanh' and active;
  if n <> 1 or amount is distinct from course_base + 500000
     or exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = test_id and active) then
    raise exception 'Partner reroute must offset full base/cart cost without a course debit'; end if;
  update public.golf_reservations set smart_cart_note = '600,000' where id = test_id;
  select count(*), max(amount_vnd) into n, amount from public.golf_partner_reservation_offsets where reservation_id = test_id and active;
  if n <> 1 or amount is distinct from course_base + 600000
     or exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = test_id and active) then
    raise exception 'Partner cart edit failed'; end if;
  update public.golf_reservations set cost_settlement_type = 'golf_course', cost_partner_name = null where id = test_id;
  select count(*), max(amount_vnd) into n, amount from public.golf_course_budget_reservation_charges where reservation_id = test_id and active;
  if n <> 1 or amount is distinct from course_base + 600000
     or exists (select 1 from public.golf_partner_reservation_offsets where reservation_id = test_id and active) then
    raise exception 'Reroute back to direct settlement failed'; end if;

  if payments_before is distinct from (select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
      from public.golf_reservation_payments p where p.reservation_id = test_id) then
    raise exception 'Actual payments unexpectedly changed'; end if;
  if account_before is distinct from (select to_jsonb(a) from public.golf_course_budget_accounts a where a.golf_course = r.golf_course) then
    raise exception 'Course opening balance unexpectedly changed'; end if;
end;
$$;
rollback;
select 'PASS: S-CART parser, totals, settlement transitions and payment preservation; all changes rolled back' as status;
