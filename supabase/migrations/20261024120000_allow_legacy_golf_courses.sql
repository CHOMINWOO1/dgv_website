begin;

alter table public.golf_reservations
  drop constraint if exists golf_reservations_golf_course_check;

alter table public.golf_reservations
  add constraint golf_reservations_golf_course_check
  check (golf_course in ('AT1200', 'SAM', 'PALACE', 'KN', 'DB'))
  not valid;

alter table public.golf_reservations
  validate constraint golf_reservations_golf_course_check;

commit;
