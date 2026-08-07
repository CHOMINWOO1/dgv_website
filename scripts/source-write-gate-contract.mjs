const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const API_GRANTEES = new Set(["PUBLIC", "anon", "authenticated", "service_role"]);
const OBJECT_PRIVILEGES = Object.freeze({
  relation: new Set(["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]),
  sequence: new Set(["USAGE", "UPDATE"]),
  column: new Set(["INSERT", "UPDATE", "REFERENCES"]),
  routine: new Set(["EXECUTE"]),
});

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseSnapshot(value) {
  const snapshot = typeof value === "string" ? JSON.parse(value) : value;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("snapshot must be a JSON object");
  }
  if (snapshot.contract_version !== 1 || snapshot.read_only !== true) {
    throw new TypeError("snapshot must be the read-only version 1 ACL contract");
  }
  if (!SAFE_ROLE_PATTERN.test(snapshot.captured_by ?? "")) {
    throw new TypeError("snapshot captured_by is not a safe role name");
  }
  if (typeof snapshot.database !== "string" || snapshot.database.length === 0
      || snapshot.database.includes("\0")) {
    throw new TypeError("snapshot database is invalid");
  }
  if (!SHA256_PATTERN.test(snapshot.effective_acl_fingerprint ?? "")) {
    throw new TypeError("snapshot effective_acl_fingerprint must be lowercase SHA-256");
  }
  if (snapshot.restorable_by_captured_role !== true) {
    throw new TypeError("snapshot is not exactly restorable by its captured role");
  }
  if (!Array.isArray(snapshot.entries)) {
    throw new TypeError("snapshot entries must be an array");
  }

  const affected = snapshot.entries.filter((entry) => entry?.affected === true);
  if (!Number.isSafeInteger(snapshot.affected_entry_count)
      || snapshot.affected_entry_count !== affected.length) {
    throw new TypeError("snapshot affected_entry_count does not match entries");
  }
  if (affected.length === 0) {
    throw new TypeError("snapshot has no API mutation grants to close");
  }

  for (const entry of affected) {
    const allowed = OBJECT_PRIVILEGES[entry.object_kind];
    if (!allowed?.has(entry.privilege_type)) {
      throw new TypeError("snapshot contains an unsupported affected privilege");
    }
    if (entry.schema_name !== "public") {
      throw new TypeError("only public-schema ACL entries are allowed");
    }
    if (typeof entry.object_name !== "string" || entry.object_name.length === 0
        || entry.object_name.includes("\0")) {
      throw new TypeError("snapshot contains an invalid object name");
    }
    if (!API_GRANTEES.has(entry.grantee)) {
      throw new TypeError("snapshot contains an unexpected affected grantee");
    }
    if (entry.grantor !== snapshot.captured_by) {
      throw new TypeError("an affected grant was made by a different grantor");
    }
    if (typeof entry.is_grantable !== "boolean") {
      throw new TypeError("snapshot is_grantable must be boolean");
    }
    if (entry.grantee === "PUBLIC" && entry.is_grantable) {
      throw new TypeError("PUBLIC cannot receive a grant option");
    }
    if (entry.object_kind === "column"
        && (typeof entry.column_name !== "string" || entry.column_name.length === 0
          || entry.column_name.includes("\0"))) {
      throw new TypeError("snapshot contains an invalid column name");
    }
    if (entry.object_kind === "routine") {
      if (!new Set(["f", "p"]).has(entry.object_subkind)
          || typeof entry.identity_arguments !== "string"
          || entry.identity_arguments.includes("\0")) {
        throw new TypeError("snapshot contains invalid routine identity data");
      }
    }
  }

  return {
    capturedBy: snapshot.captured_by,
    database: snapshot.database,
    fingerprint: snapshot.effective_acl_fingerprint,
    affected: affected.map((entry) => ({
      object_kind: entry.object_kind,
      schema_name: entry.schema_name,
      object_name: entry.object_name,
      object_subkind: entry.object_subkind,
      column_name: entry.column_name ?? null,
      identity_arguments: entry.identity_arguments ?? null,
      grantor: entry.grantor,
      grantee: entry.grantee,
      privilege_type: entry.privilege_type,
      is_grantable: entry.is_grantable,
    })),
  };
}

// This is deliberately the same effective-ACL graph and byte ordering used by
// source_write_gate_acl_snapshot.sql. It avoids depending on raw NULL-vs-expanded
// ACL storage while still proving exact grants, grantors and grant options.
const ACL_FINGERPRINT_INTO_SQL = String.raw`
  with
  relation_entries as (
    select
      case when c.relkind = 'S' then 'sequence' else 'relation' end::text as object_kind,
      n.nspname::text as schema_name,
      c.relname::text as object_name,
      c.relkind::text as object_subkind,
      null::text as column_name,
      null::text as identity_arguments,
      pg_catalog.pg_get_userbyid(x.grantor)::text as grantor,
      case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end as grantee,
      x.privilege_type::text,
      x.is_grantable
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
      case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end as grantee,
      x.privilege_type::text,
      x.is_grantable
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
      case when x.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee)::text end as grantee,
      x.privilege_type::text,
      x.is_grantable
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
    union all select * from column_entries
    union all select * from routine_entries
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
      ) as fingerprint_line
    from entries as e
  )
  select pg_catalog.encode(
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
  )
  into v_actual_fingerprint
  from normalized as n;`;

const GATE_CLOSED_INTO_SQL = String.raw`
  with
  business_tables(table_name) as (
    values
      ('menu_items'::text), ('orders'::text), ('order_items'::text),
      ('order_custom_items'::text), ('resv_groups'::text), ('notices'::text)
  ),
  api_roles(role_name) as (
    values ('anon'::name), ('authenticated'::name), ('service_role'::name)
  ),
  public_relation_state as (
    select
      c.relname,
      t.table_name is not null as is_expected_business_table,
      r.role_name,
      pg_catalog.has_table_privilege(
        r.role_name, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) or pg_catalog.has_any_column_privilege(
        r.role_name, c.oid, 'INSERT,UPDATE,REFERENCES'
      ) as has_any_mutation
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n
      on n.oid = c.relnamespace and n.nspname = 'public'
    cross join api_roles as r
    left join business_tables as t on t.table_name = c.relname
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
  ),
  callable_public_mutators as (
    select p.oid
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and p.provolatile = 'v'
      and p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
  ),
  function_state as (
    select
      pg_catalog.has_schema_privilege(r.role_name, 'public', 'USAGE')
      and pg_catalog.has_function_privilege(r.role_name, p.oid, 'EXECUTE') as can_execute
    from callable_public_mutators as p
    cross join api_roles as r
  ),
  sequence_state as (
    select
      pg_catalog.has_sequence_privilege(r.role_name, c.oid, 'USAGE')
      or pg_catalog.has_sequence_privilege(r.role_name, c.oid, 'UPDATE') as can_advance
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n
      on n.oid = c.relnamespace and n.nspname = 'public'
    cross join api_roles as r
    where c.relkind = 'S'
  )
  select
    (select pg_catalog.count(distinct r.relname)
       from public_relation_state as r where r.is_expected_business_table) = 6
    and not exists (select 1 from public_relation_state as r where r.has_any_mutation)
    and not exists (select 1 from function_state as f where f.can_execute)
    and not exists (select 1 from sequence_state as s where s.can_advance)
  into v_gate_closed;`;

const APPLY_ENTRIES_SQL = String.raw`
  for v_entry in select value from pg_catalog.jsonb_array_elements(v_entries)
  loop
    v_grantee_sql := case
      when v_entry->>'grantee' = 'PUBLIC' then 'PUBLIC'
      else pg_catalog.format('%I', v_entry->>'grantee')
    end;
    v_grant_option_sql := case
      when (v_entry->>'is_grantable')::boolean then ' with grant option'
      else ''
    end;

    if v_entry->>'object_kind' = 'relation' then
      perform c.oid
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = v_entry->>'schema_name'
        and c.relname = v_entry->>'object_name'
        and c.relkind::text = v_entry->>'object_subkind';
      if not found then raise exception 'ACL object changed: %.%', v_entry->>'schema_name', v_entry->>'object_name'; end if;
      execute pg_catalog.format(
        '__DGV_VERB__ %s on table %I.%I __DGV_PREPOSITION__ %s%s',
        v_entry->>'privilege_type', v_entry->>'schema_name', v_entry->>'object_name',
        v_grantee_sql, __DGV_GRANT_OPTION__
      );
    elsif v_entry->>'object_kind' = 'sequence' then
      perform c.oid
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = v_entry->>'schema_name'
        and c.relname = v_entry->>'object_name'
        and c.relkind = 'S';
      if not found then raise exception 'ACL sequence changed: %.%', v_entry->>'schema_name', v_entry->>'object_name'; end if;
      execute pg_catalog.format(
        '__DGV_VERB__ %s on sequence %I.%I __DGV_PREPOSITION__ %s%s',
        v_entry->>'privilege_type', v_entry->>'schema_name', v_entry->>'object_name',
        v_grantee_sql, __DGV_GRANT_OPTION__
      );
    elsif v_entry->>'object_kind' = 'column' then
      perform a.attnum
      from pg_catalog.pg_attribute as a
      join pg_catalog.pg_class as c on c.oid = a.attrelid
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = v_entry->>'schema_name'
        and c.relname = v_entry->>'object_name'
        and c.relkind::text = v_entry->>'object_subkind'
        and a.attname = v_entry->>'column_name'
        and a.attnum > 0 and not a.attisdropped;
      if not found then raise exception 'ACL column changed: %.%.%', v_entry->>'schema_name', v_entry->>'object_name', v_entry->>'column_name'; end if;
      execute pg_catalog.format(
        '__DGV_VERB__ %s (%I) on table %I.%I __DGV_PREPOSITION__ %s%s',
        v_entry->>'privilege_type', v_entry->>'column_name',
        v_entry->>'schema_name', v_entry->>'object_name',
        v_grantee_sql, __DGV_GRANT_OPTION__
      );
    else
      select p.oid
      into strict v_routine_oid
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = v_entry->>'schema_name'
        and p.proname = v_entry->>'object_name'
        and p.prokind::text = v_entry->>'object_subkind'
        and pg_catalog.pg_get_function_identity_arguments(p.oid) = v_entry->>'identity_arguments';
      execute pg_catalog.format(
        '__DGV_VERB__ execute on routine %s __DGV_PREPOSITION__ %s%s',
        v_routine_oid::pg_catalog.regprocedure, v_grantee_sql, __DGV_GRANT_OPTION__
      );
    end if;
  end loop;`;

function renderApplyEntries({ verb, preposition, grantOption }) {
  return APPLY_ENTRIES_SQL
    .replaceAll("__DGV_VERB__", verb)
    .replaceAll("__DGV_PREPOSITION__", preposition)
    .replaceAll("__DGV_GRANT_OPTION__", grantOption);
}

function scriptPreamble(contract) {
  return String.raw`begin isolation level serializable;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local search_path = pg_catalog;
select pg_catalog.pg_advisory_xact_lock(7526764703220713081::bigint);

do $dgv_source_gate$
declare
  v_entries jsonb := ${sqlLiteral(JSON.stringify(contract.affected))}::jsonb;
  v_expected_fingerprint text := ${sqlLiteral(contract.fingerprint)};
  v_actual_fingerprint text;
  v_gate_closed boolean;
  v_entry jsonb;
  v_grantee_sql text;
  v_grant_option_sql text;
  v_routine_oid oid;
begin
  if current_user <> ${sqlLiteral(contract.capturedBy)} then
    raise exception 'source gate must run as captured role % (actual %)', ${sqlLiteral(contract.capturedBy)}, current_user;
  end if;
  if pg_catalog.current_database() <> ${sqlLiteral(contract.database)} then
    raise exception 'source gate database mismatch';
  end if;`;
}

export function buildSourceGateCloseSql(snapshot) {
  const contract = parseSnapshot(snapshot);
  return `${scriptPreamble(contract)}
${ACL_FINGERPRINT_INTO_SQL}
  if v_actual_fingerprint is distinct from v_expected_fingerprint then
    raise exception 'source ACL changed after snapshot (expected %, actual %)', v_expected_fingerprint, v_actual_fingerprint;
  end if;
${renderApplyEntries({ verb: "revoke", preposition: "from", grantOption: "''" })}
${GATE_CLOSED_INTO_SQL}
  if v_gate_closed is not true then
    raise exception 'source_api_write_gate_status is not closed; all revokes rolled back';
  end if;
end
$dgv_source_gate$;

select pg_catalog.jsonb_build_object(
  'contract_version', 1,
  'closed', true,
  'snapshot_effective_acl_fingerprint', ${sqlLiteral(contract.fingerprint)}
)::text;
commit;`;
}

export function buildSourceGateOpenSql(snapshot) {
  const contract = parseSnapshot(snapshot);
  return `${scriptPreamble(contract)}
${GATE_CLOSED_INTO_SQL}
  if v_gate_closed is not true then
    raise exception 'source_api_write_gate_status is not closed; reopen refused';
  end if;
${renderApplyEntries({ verb: "grant", preposition: "to", grantOption: "v_grant_option_sql" })}
${ACL_FINGERPRINT_INTO_SQL}
  if v_actual_fingerprint is distinct from v_expected_fingerprint then
    raise exception 'source ACL fingerprint was not restored exactly (expected %, actual %); reopen grants rolled back', v_expected_fingerprint, v_actual_fingerprint;
  end if;
end
$dgv_source_gate$;

select pg_catalog.jsonb_build_object(
  'contract_version', 1,
  'restored', true,
  'effective_acl_fingerprint', ${sqlLiteral(contract.fingerprint)}
)::text;
commit;`;
}

export function summarizeSourceGateSnapshot(snapshot) {
  const contract = parseSnapshot(snapshot);
  return Object.freeze({
    capturedBy: contract.capturedBy,
    database: contract.database,
    effectiveAclFingerprint: contract.fingerprint,
    affectedEntryCount: contract.affected.length,
  });
}
