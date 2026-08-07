\set ON_ERROR_STOP on

-- Source-only, READ ONLY ACL snapshot. The canonical fingerprint describes
-- effective relation, column, sequence, function, and procedure privileges;
-- it intentionally ignores whether a default ACL is stored as NULL or expanded.
begin transaction isolation level repeatable read read only;

with
api_grantees as (
  select 0::oid as oid
  union all
  select r.oid
  from pg_catalog.pg_roles as r
  where r.rolname in ('anon', 'authenticated', 'service_role')
),
relation_entries as (
  select
    case when c.relkind = 'S' then 'sequence' else 'relation' end::text as object_kind,
    n.nspname::text as schema_name,
    c.relname::text as object_name,
    c.relkind::text as object_subkind,
    null::text as column_name,
    null::text as identity_arguments,
    pg_catalog.pg_get_userbyid(x.grantor)::text as grantor,
    case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end
      as grantee,
    x.privilege_type::text,
    x.is_grantable,
    x.grantee in (select oid from api_grantees)
      and (
        (c.relkind = 'S' and x.privilege_type in ('USAGE', 'UPDATE'))
        or (c.relkind <> 'S' and x.privilege_type in (
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        ))
      ) as affected
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n
    on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      c.relacl,
      pg_catalog.acldefault(
        case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
        c.relowner
      )
    )
  ) as x
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
),
column_entries as (
  select
    'column'::text as object_kind,
    n.nspname::text as schema_name,
    c.relname::text as object_name,
    c.relkind::text as object_subkind,
    a.attname::text as column_name,
    null::text as identity_arguments,
    pg_catalog.pg_get_userbyid(x.grantor)::text as grantor,
    case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end
      as grantee,
    x.privilege_type::text,
    x.is_grantable,
    x.grantee in (select oid from api_grantees)
      and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES') as affected
  from pg_catalog.pg_attribute as a
  join pg_catalog.pg_class as c on c.oid = a.attrelid
  join pg_catalog.pg_namespace as n
    on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral pg_catalog.aclexplode(a.attacl) as x
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and a.attnum > 0
    and not a.attisdropped
    and a.attacl is not null
),
routine_entries as (
  select
    'routine'::text as object_kind,
    n.nspname::text as schema_name,
    p.proname::text as object_name,
    p.prokind::text as object_subkind,
    null::text as column_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid)::text as identity_arguments,
    pg_catalog.pg_get_userbyid(x.grantor)::text as grantor,
    case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end
      as grantee,
    x.privilege_type::text,
    x.is_grantable,
    x.grantee in (select oid from api_grantees)
      and x.privilege_type = 'EXECUTE'
      and p.provolatile = 'v'
      and p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype as affected
  from pg_catalog.pg_proc as p
  join pg_catalog.pg_namespace as n
    on n.oid = p.pronamespace and n.nspname = 'public'
  cross join lateral pg_catalog.aclexplode(
    coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
  ) as x
  where p.prokind in ('f', 'p')
),
entries as (
  select * from relation_entries
  union all
  select * from column_entries
  union all
  select * from routine_entries
),
normalized as (
  select
    e.*,
    pg_catalog.concat_ws(
      chr(31),
      e.object_kind,
      e.schema_name,
      e.object_name,
      e.object_subkind,
      coalesce(e.column_name, ''),
      coalesce(e.identity_arguments, ''),
      e.grantor,
      e.grantee,
      e.privilege_type,
      e.is_grantable::text
    ) as fingerprint_line,
    case
      when not e.affected then null
      when e.object_kind = 'relation' then pg_catalog.format(
        'grant %s on table %I.%I to %s%s;',
        e.privilege_type,
        e.schema_name,
        e.object_name,
        case when e.grantee = 'PUBLIC' then 'PUBLIC' else pg_catalog.format('%I', e.grantee) end,
        case when e.is_grantable then ' with grant option' else '' end
      )
      when e.object_kind = 'sequence' then pg_catalog.format(
        'grant %s on sequence %I.%I to %s%s;',
        e.privilege_type,
        e.schema_name,
        e.object_name,
        case when e.grantee = 'PUBLIC' then 'PUBLIC' else pg_catalog.format('%I', e.grantee) end,
        case when e.is_grantable then ' with grant option' else '' end
      )
      when e.object_kind = 'column' then pg_catalog.format(
        'grant %s (%I) on table %I.%I to %s%s;',
        e.privilege_type,
        e.column_name,
        e.schema_name,
        e.object_name,
        case when e.grantee = 'PUBLIC' then 'PUBLIC' else pg_catalog.format('%I', e.grantee) end,
        case when e.is_grantable then ' with grant option' else '' end
      )
      else pg_catalog.format(
        'grant execute on routine %I.%I(%s) to %s%s;',
        e.schema_name,
        e.object_name,
        e.identity_arguments,
        case when e.grantee = 'PUBLIC' then 'PUBLIC' else pg_catalog.format('%I', e.grantee) end,
        case when e.is_grantable then ' with grant option' else '' end
      )
    end as restore_sql
  from entries as e
),
snapshot as (
  select
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          coalesce(
            pg_catalog.string_agg(
              n.fingerprint_line,
              chr(10) order by
                n.object_kind,
                n.schema_name,
                n.object_name,
                n.object_subkind,
                n.column_name,
                n.identity_arguments,
                n.grantor,
                n.grantee,
                n.privilege_type,
                n.is_grantable
            ),
            ''
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ) as fingerprint,
    pg_catalog.bool_and(not n.affected or n.grantor = current_user) as restorable,
    pg_catalog.count(*) filter (where n.affected)::bigint as affected_entry_count,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'object_kind', n.object_kind,
        'schema_name', n.schema_name,
        'object_name', n.object_name,
        'object_subkind', n.object_subkind,
        'column_name', n.column_name,
        'identity_arguments', n.identity_arguments,
        'grantor', n.grantor,
        'grantee', n.grantee,
        'privilege_type', n.privilege_type,
        'is_grantable', n.is_grantable,
        'affected', n.affected,
        'restore_sql', n.restore_sql
      ) order by
        n.object_kind,
        n.schema_name,
        n.object_name,
        n.object_subkind,
        n.column_name,
        n.identity_arguments,
        n.grantor,
        n.grantee,
        n.privilege_type,
        n.is_grantable
    ) as entries
  from normalized as n
)
select pg_catalog.jsonb_build_object(
  'contract_version', 1,
  'read_only', pg_catalog.current_setting('transaction_read_only') = 'on',
  'captured_by', current_user,
  'database', pg_catalog.current_database(),
  'effective_acl_fingerprint', s.fingerprint,
  'restorable_by_captured_role', s.restorable,
  'affected_entry_count', s.affected_entry_count,
  'entries', s.entries
)::text
from snapshot as s;

commit;
