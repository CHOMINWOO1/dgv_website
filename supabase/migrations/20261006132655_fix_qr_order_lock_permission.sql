-- PostgreSQL locking clauses require UPDATE privilege on at least one column.
-- Keep the permission server-only and column-scoped so guest/client roles remain blocked.
grant update (updated_at)
on table public.menu_combo_components
to service_role;
