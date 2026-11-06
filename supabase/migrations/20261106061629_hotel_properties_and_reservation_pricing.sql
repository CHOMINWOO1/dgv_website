create table public.hotel_properties (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and length(name) <= 200),
  weekday_purchase bigint not null check (weekday_purchase between 0 and 999999999999),
  weekday_sale bigint not null check (weekday_sale between 0 and 999999999999),
  weekend_purchase bigint not null check (weekend_purchase between 0 and 999999999999),
  weekend_sale bigint not null check (weekend_sale between 0 and 999999999999),
  weekend_days integer[] not null default array[6,0]
    check (weekend_days <@ array[0,1,2,3,4,5,6] and array_position(weekend_days,null) is null),
  version integer not null default 1,
  created_at timestamptz not null default now()
);
alter table public.hotel_properties enable row level security;
revoke all on public.hotel_properties from public, anon, authenticated;
grant select, insert, update, delete on public.hotel_properties to authenticated;
create policy hotel_properties_manager_admin on public.hotel_properties
for all to authenticated
using ((select public.current_app_role()) in ('manager','admin'))
with check ((select public.current_app_role()) in ('manager','admin'));

alter table public.hotel_reservations
  add column hotel_id uuid references public.hotel_properties(id) on delete restrict,
  add column room_count integer not null default 1 check (room_count between 1 and 10000),
  add column pricing_mode text not null default 'legacy' check (pricing_mode in ('legacy','standard','surcharge')),
  add column rate_snapshot jsonb,
  add column hotel_version integer,
  add column weekday_nights integer not null default 0,
  add column weekend_nights integer not null default 0,
  add column room_purchase_amount bigint not null default 0 check (room_purchase_amount between 0 and 999999999999),
  add column room_sale_amount bigint not null default 0 check (room_sale_amount between 0 and 999999999999),
  add column includes_meals boolean not null default false,
  add column meal_purchase_amount bigint not null default 0 check (meal_purchase_amount between 0 and 999999999999),
  add column meal_sale_amount bigint not null default 0 check (meal_sale_amount between 0 and 999999999999),
  add column version integer not null default 1;
update public.hotel_reservations set room_purchase_amount=purchase_amount, room_sale_amount=sale_amount;
create index hotel_reservations_hotel_id_idx on public.hotel_reservations(hotel_id);
create index hotel_reservations_check_in_idx on public.hotel_reservations(check_in desc,id);
grant insert (id,hotel_id,room_count,pricing_mode,hotel_version,room_purchase_amount,room_sale_amount,includes_meals,meal_purchase_amount,meal_sale_amount),
      update (hotel_id,room_count,pricing_mode,hotel_version,room_purchase_amount,room_sale_amount,includes_meals,meal_purchase_amount,meal_sale_amount)
  on public.hotel_reservations to authenticated;

create function public.prepare_hotel_property() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  new.name := btrim(new.name);
  if tg_op='UPDATE' then
    new.id := old.id;
    new.created_at := old.created_at;
    new.version := old.version + 1;
  else
    new.version := 1;
  end if;
  return new;
end $$;
revoke all on function public.prepare_hotel_property() from public,anon,authenticated;
create trigger prepare_hotel_property before insert or update on public.hotel_properties
for each row execute function public.prepare_hotel_property();

create function public.prepare_hotel_reservation() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  hotel public.hotel_properties;
  reprice boolean;
  stay_date date;
begin
  if new.check_out <= new.check_in then raise exception 'Check-out must follow check-in'; end if;
  if tg_op='UPDATE' then
    new.version := old.version + 1;
    new.id := old.id;
    new.created_at := old.created_at;
  else
    new.version := 1;
  end if;

  -- Preserve the original manual-entry API and historical reservations.
  if new.pricing_mode='legacy' then
    if tg_op='UPDATE' and old.pricing_mode<>'legacy' then
      raise exception 'Cannot convert a priced reservation to legacy';
    end if;
    new.room_purchase_amount := new.purchase_amount;
    new.room_sale_amount := new.sale_amount;
    new.includes_meals := false;
    new.meal_purchase_amount := 0;
    new.meal_sale_amount := 0;
    return new;
  end if;
  if new.check_out-new.check_in > 3660 then raise exception 'Stay exceeds 3660 nights'; end if;
  if new.hotel_id is null then raise exception 'Select a registered hotel'; end if;
  select * into strict hotel from public.hotel_properties where id=new.hotel_id for share;
  if tg_op='INSERT' or new.hotel_id is distinct from old.hotel_id then
    new.hotel_name := hotel.name;
  else
    new.hotel_name := old.hotel_name;
  end if;
  if tg_op='INSERT' then
    reprice := true;
  else
    reprice := row(new.hotel_id,new.check_in,new.check_out,new.room_count,new.pricing_mode)
      is distinct from row(old.hotel_id,old.check_in,old.check_out,old.room_count,old.pricing_mode);
  end if;
  if new.pricing_mode='standard' then
    if reprice then
      if new.hotel_version is distinct from hotel.version then
        raise exception using errcode='40001', message='Hotel rates changed. Reload and review the price.';
      end if;
      new.rate_snapshot := jsonb_build_object(
        'weekday_purchase',hotel.weekday_purchase,'weekday_sale',hotel.weekday_sale,
        'weekend_purchase',hotel.weekend_purchase,'weekend_sale',hotel.weekend_sale,
        'weekend_days',hotel.weekend_days);
      new.weekday_nights := 0;
      new.weekend_nights := 0;
      for stay_date in select new.check_in + d from generate_series(0,new.check_out-new.check_in-1) as d loop
        if extract(dow from stay_date)::integer=any(hotel.weekend_days) then
          new.weekend_nights := new.weekend_nights+1;
        else
          new.weekday_nights := new.weekday_nights+1;
        end if;
      end loop;
      new.room_purchase_amount := new.room_count::bigint*(new.weekday_nights::bigint*hotel.weekday_purchase+new.weekend_nights::bigint*hotel.weekend_purchase);
      new.room_sale_amount := new.room_count::bigint*(new.weekday_nights::bigint*hotel.weekday_sale+new.weekend_nights::bigint*hotel.weekend_sale);
    else
      new.hotel_version := old.hotel_version;
      new.rate_snapshot := old.rate_snapshot;
      new.weekday_nights := old.weekday_nights;
      new.weekend_nights := old.weekend_nights;
      new.room_purchase_amount := old.room_purchase_amount;
      new.room_sale_amount := old.room_sale_amount;
    end if;
  else
    new.rate_snapshot := null;
    new.hotel_version := null;
    new.weekday_nights := 0;
    new.weekend_nights := 0;
  end if;
  if not new.includes_meals then
    new.meal_purchase_amount := 0;
    new.meal_sale_amount := 0;
  end if;
  new.purchase_amount := new.room_purchase_amount + new.meal_purchase_amount;
  new.sale_amount := new.room_sale_amount + new.meal_sale_amount;
  return new;
end $$;
revoke all on function public.prepare_hotel_reservation() from public,anon,authenticated;
create trigger prepare_hotel_reservation before insert or update on public.hotel_reservations
for each row execute function public.prepare_hotel_reservation();
