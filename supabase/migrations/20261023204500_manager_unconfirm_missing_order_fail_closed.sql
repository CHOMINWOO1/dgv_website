-- A manager must never use the legacy missing-order recovery path after a
-- linked paid order becomes invisible through sales_excluded RLS. This can
-- happen when an administrator excludes the order after the manager locks the
-- reservation but before the manager locks the paid order. Administrators keep
-- the existing recovery path for genuinely missing legacy orders.
--
-- This migration rewrites one exact anchor in the live function definition.
-- It does not read or mutate application rows.
do $manager_unconfirm_missing_order_guard$
declare
  v_signature constant text := 'public.app_unconfirm_reservation(bigint)';
  v_oid oid := pg_catalog.to_regprocedure(v_signature);
  v_definition text;
  v_rewritten text;
  v_count integer;
  v_old_anchor constant text := E'  if not found then\n    -- Imported legacy data can contain a confirmed reservation whose order was';
  v_new_anchor constant text := E'  if not found then\n    if public.current_app_role() = ''manager'' then\n      raise exception using\n        errcode = ''P0002'',\n        message = ''reservation not found'';\n    end if;\n\n    -- Imported legacy data can contain a confirmed reservation whose order was';
  v_admin_recovery_anchor constant text := E'    -- Imported legacy data can contain a confirmed reservation whose order was\n    -- already lost. Explicit unconfirm is the only recovery operation: it\n    -- clears the reservation reference and performs no order/item DML.\n    perform pg_catalog.set_config(''app.rpc_write'', ''on'', true);\n    update public.resv_groups\n    set confirmed = false,\n        confirmed_at = null,\n        confirmed_order_id = null';
  v_owner oid;
  v_acl aclitem[];
  v_config text[];
  v_security_definer boolean;
  v_authenticated_execute boolean;
  v_post_owner oid;
  v_post_acl aclitem[];
  v_post_config text[];
  v_post_security_definer boolean;
  v_post_authenticated_execute boolean;
begin
  if v_oid is null then
    raise exception 'manager unconfirm guard: required function is missing: %', v_signature;
  end if;

  select function_row.proowner,
         function_row.proacl,
         function_row.proconfig,
         function_row.prosecdef,
         pg_catalog.has_function_privilege(
           'authenticated',
           function_row.oid,
           'EXECUTE'
         )
  into v_owner,
       v_acl,
       v_config,
       v_security_definer,
       v_authenticated_execute
  from pg_catalog.pg_proc as function_row
  where function_row.oid = v_oid;

  if v_security_definer then
    raise exception 'manager unconfirm guard: target unexpectedly uses SECURITY DEFINER';
  end if;
  if not v_authenticated_execute then
    raise exception 'manager unconfirm guard: authenticated EXECUTE is missing before rewrite';
  end if;
  if pg_catalog.array_position(v_config, 'search_path=""') is null then
    raise exception 'manager unconfirm guard: hardened empty search_path is missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_oid);

  if pg_catalog.strpos(
       v_definition,
       'array[''manager'', ''admin'']::text[]'
     ) = 0 then
    raise exception 'manager unconfirm guard: manager/admin authorization gate is missing';
  end if;

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_anchor, ''))
  ) / pg_catalog.length(v_old_anchor);

  if v_count <> 1 then
    raise exception
      'manager unconfirm guard: expected one live missing-order recovery anchor, found %',
      v_count;
  end if;

  v_rewritten := pg_catalog.replace(v_definition, v_old_anchor, v_new_anchor);
  execute v_rewritten;

  if pg_catalog.to_regprocedure(v_signature)::oid is distinct from v_oid then
    raise exception 'manager unconfirm guard: function identity changed during rewrite';
  end if;

  select function_row.proowner,
         function_row.proacl,
         function_row.proconfig,
         function_row.prosecdef,
         pg_catalog.has_function_privilege(
           'authenticated',
           function_row.oid,
           'EXECUTE'
         ),
         pg_catalog.pg_get_functiondef(function_row.oid)
  into v_post_owner,
       v_post_acl,
       v_post_config,
       v_post_security_definer,
       v_post_authenticated_execute,
       v_definition
  from pg_catalog.pg_proc as function_row
  where function_row.oid = v_oid;

  if v_post_owner is distinct from v_owner
     or v_post_acl is distinct from v_acl
     or v_post_config is distinct from v_config
     or v_post_security_definer is distinct from v_security_definer
     or v_post_authenticated_execute is distinct from v_authenticated_execute then
    raise exception 'manager unconfirm guard: function security metadata changed';
  end if;

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_new_anchor, ''))
  ) / pg_catalog.length(v_new_anchor);

  if v_count <> 1
     or pg_catalog.strpos(v_definition, v_old_anchor) > 0
     or pg_catalog.strpos(v_definition, v_admin_recovery_anchor) = 0
     or pg_catalog.strpos(
       v_definition,
       'select o.source, o.total_usd, o.total_vnd'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'select o.source, o.total_usd, o.total_vnd'
     ) >= pg_catalog.strpos(v_definition, v_new_anchor) then
    raise exception 'manager unconfirm guard: post-rewrite verification failed';
  end if;
end;
$manager_unconfirm_missing_order_guard$;
