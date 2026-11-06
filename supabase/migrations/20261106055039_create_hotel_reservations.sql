create table public.hotel_reservations (
  id uuid primary key default gen_random_uuid(),
  hotel_name text not null check (btrim(hotel_name) <> ''),
  check_in date not null,
  check_out date not null check (check_out > check_in),
  guest_count integer not null check (guest_count > 0),
  guest_names text not null check (btrim(guest_names, E' \t\r\n') <> ''),
  purchase_amount bigint not null check (purchase_amount between 0 and 999999999999),
  sale_amount bigint not null check (sale_amount between 0 and 999999999999),
  created_at timestamptz not null default now()
);
alter table public.hotel_reservations enable row level security;
revoke all on public.hotel_reservations from public, anon, authenticated;
grant select, delete on public.hotel_reservations to authenticated;
grant insert (hotel_name, check_in, check_out, guest_count, guest_names, purchase_amount, sale_amount),
      update (hotel_name, check_in, check_out, guest_count, guest_names, purchase_amount, sale_amount)
  on public.hotel_reservations to authenticated;
create policy hotel_reservations_manager_admin on public.hotel_reservations
  for all to authenticated
  using ((select public.current_app_role()) in ('manager', 'admin'))
  with check ((select public.current_app_role()) in ('manager', 'admin'));
