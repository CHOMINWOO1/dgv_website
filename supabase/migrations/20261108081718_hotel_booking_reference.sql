-- CLI-created migration version aligned to the hosted migration history.
-- Add only an optional supplier confirmation number. No backfill or repricing.
set local lock_timeout = '3s';
do $$
declare before_hash text; after_hash text;
begin
  lock table public.hotel_reservations in access exclusive mode;
  select md5(coalesce(string_agg(to_jsonb(r)::text, '' order by id), '')) into before_hash
    from public.hotel_reservations r;
  alter table public.hotel_reservations add column booking_reference text
    check (booking_reference is null or (char_length(btrim(booking_reference)) between 1 and 120
      and booking_reference !~ '[[:cntrl:]]'));
  select md5(coalesce(string_agg((to_jsonb(r)-'booking_reference')::text, '' order by id), '')) into after_hash
    from public.hotel_reservations r;
  if before_hash is distinct from after_hash then raise exception 'Existing hotel data changed'; end if;
end $$;
grant insert (booking_reference), update (booking_reference)
  on public.hotel_reservations to authenticated;
comment on column public.hotel_reservations.booking_reference is
  'Optional hotel/supplier confirmation reference, separate from internal UUID. Existing manager/admin RLS remains in force; old rows remain NULL.';

