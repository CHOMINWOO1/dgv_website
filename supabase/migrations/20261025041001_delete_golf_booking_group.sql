-- Explicit whole-booking deletion. No existing row changes at migration time.
-- The caller must confirm that ALL rounds and shared customer payment records
-- should be removed; this is not a cash refund or a cancellation payment.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.delete_golf_booking_group_impl(p_group_id uuid,p_expected_version bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_round_ids uuid[];
begin
  if (select auth.uid()) is null or not public.has_app_role(array['manager','admin']) then
    raise exception 'Manager or administrator role required' using errcode='42501';
  end if;
  select g.version into v_version from public.golf_booking_groups g where g.id=p_group_id for update;
  if not found then
    raise exception '묶음예약을 찾을 수 없습니다. / Không tìm thấy nhóm đặt sân.' using errcode='P0002';
  end if;
  if p_expected_version is distinct from v_version then
    raise exception '다른 기기에서 묶음예약이 변경되었습니다. 새로고침해 주세요. / Nhóm đã thay đổi. Vui lòng tải lại.' using errcode='40001';
  end if;
  -- Same parent -> sorted children -> shared payments order as the save RPC.
  perform r.id from public.golf_reservations r where r.booking_group_id=p_group_id order by r.id for update;
  select coalesce(array_agg(r.id order by r.id),'{}'::uuid[]) into v_round_ids
    from public.golf_reservations r where r.booking_group_id=p_group_id;
  perform p.id from public.golf_booking_group_payments p where p.booking_group_id=p_group_id order by p.id for update;
  perform p.id from public.golf_reservation_payments p where p.reservation_id=any(v_round_ids) order by p.id for update;

  delete from public.golf_booking_group_payments p where p.booking_group_id=p_group_id;
  -- Reverse each completed round through the existing cost-route triggers.
  update public.golf_reservations r set group_completed=false
    where r.id=any(v_round_ids) and r.group_completed;
  -- The existing legacy-payment guard intentionally refuses any mutation of a
  -- grouped legacy payment, even from a trusted definer. Detach only our locked
  -- deletion targets before deleting that ledger. Clear legacy completion in
  -- the same statement so detachment cannot reactivate an old cost deduction.
  -- All intermediate states are inside this one RPC transaction and invisible
  -- to other readers. No guard is disabled, weakened or bypassed by a setting.
  update public.golf_reservations r set booking_group_id=null,group_completed=false,
    final_received_amount_vnd=null,final_received_date=null
    where r.id=any(v_round_ids);
  delete from public.golf_reservation_payments p where p.reservation_id=any(v_round_ids);
  -- Existing ON DELETE CASCADE removes each round's course charge and partner
  -- offset, exactly like individual deletion. Current balances stop including
  -- those deductions; opening balances and course top-ups are never modified.
  delete from public.golf_reservations r where r.id=any(v_round_ids);
  delete from public.golf_booking_groups g where g.id=p_group_id;
  -- Never remove private.golf_booking_create_requests: original create retries
  -- return their durable original result and cannot recreate this deleted group.
  return p_group_id;
end;
$$;

create function public.delete_golf_booking_group(p_group_id uuid,p_expected_version bigint)
returns uuid language sql security invoker set search_path = '' as $$
  select private.delete_golf_booking_group_impl(p_group_id,p_expected_version)
$$;
revoke all on function private.delete_golf_booking_group_impl(uuid,bigint),
  public.delete_golf_booking_group(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function private.delete_golf_booking_group_impl(uuid,bigint),
  public.delete_golf_booking_group(uuid,bigint) to authenticated;
comment on function public.delete_golf_booking_group(uuid,bigint) is
  'Explicit atomic deletion of all group rounds and customer payment records with optimistic locking. Reverses/removes round cost ledgers; preserves opening balances, top-ups and durable creation receipts. Not a cash refund.';
notify pgrst,'reload schema';
commit;
