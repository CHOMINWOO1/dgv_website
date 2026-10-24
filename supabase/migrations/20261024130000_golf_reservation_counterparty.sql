-- Separate the booking counterparty from the customer representative.
--
-- The source-sheet "Name" column was initially imported into representative_name.
-- It contains partner/counterparty values such as "Chị Oanh". Preserve that value
-- in counterparty_name, then derive representative_name from the first customer in
-- player_names_en. All pricing, dates, payment fields, statuses, and audit timestamps
-- remain unchanged.

set lock_timeout = '5s';

alter table public.golf_reservations
  add column counterparty_name text;

-- Preserve the original audit timestamps during this one-time semantic split.
-- The trigger state is restored automatically if the transaction rolls back.
alter table public.golf_reservations
  disable trigger golf_reservations_touch_audit;

with parsed as (
  select
    id,
    coalesce(
      nullif(
        btrim(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                split_part(
                  (regexp_split_to_array(replace(player_names_en, E'\r', ''), E'[\n,;]+'))[1],
                  E'\t',
                  1
                ),
                E'^[[:space:]]*["''-]*[[:space:]]*([0-9]+[[:space:]]*[.)/-]?[[:space:]]*)?',
                ''
              ),
              E'[[:space:]]+(남|여)[[:space:]]*[(][MF][)][[:space:]]*$',
              '',
              'i'
            ),
            E'[[:space:]]+(MR|MS|MRS)([[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2})?[[:space:]]*$',
            '',
            'i'
          ),
          E' \t\n\r"'''
        ),
        ''
      ),
      'NAME LIST PENDING'
    ) as first_player_name
  from public.golf_reservations
)
update public.golf_reservations as reservation
set
  counterparty_name = btrim(reservation.representative_name),
  representative_name = parsed.first_player_name
from parsed
where parsed.id = reservation.id;

alter table public.golf_reservations
  enable trigger golf_reservations_touch_audit;

alter table public.golf_reservations
  alter column counterparty_name set default '직접 예약',
  alter column counterparty_name set not null;

alter table public.golf_reservations
  add constraint golf_reservations_counterparty_name_check
  check (length(btrim(counterparty_name)) between 1 and 200)
  not valid;

alter table public.golf_reservations
  validate constraint golf_reservations_counterparty_name_check;

alter table public.golf_reservations
  add constraint golf_reservations_representative_first_player_check
  check (
    representative_name = coalesce(
      nullif(
        btrim(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                split_part(
                  (regexp_split_to_array(replace(player_names_en, E'\r', ''), E'[\n,;]+'))[1],
                  E'\t',
                  1
                ),
                E'^[[:space:]]*["''-]*[[:space:]]*([0-9]+[[:space:]]*[.)/-]?[[:space:]]*)?',
                ''
              ),
              E'[[:space:]]+(남|여)[[:space:]]*[(][MF][)][[:space:]]*$',
              '',
              'i'
            ),
            E'[[:space:]]+(MR|MS|MRS)([[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2})?[[:space:]]*$',
            '',
            'i'
          ),
          E' \t\n\r"'''
        ),
        ''
      ),
      'NAME LIST PENDING'
    )
  )
  not valid;

alter table public.golf_reservations
  validate constraint golf_reservations_representative_first_player_check;

grant insert (counterparty_name)
on table public.golf_reservations
to authenticated;

grant update (counterparty_name)
on table public.golf_reservations
to authenticated;

create index golf_reservations_counterparty_name_idx
  on public.golf_reservations (lower(counterparty_name));

comment on column public.golf_reservations.counterparty_name is
  'Partner or counterparty that supplied the booking; customer representative is the first name in player_names_en.';
