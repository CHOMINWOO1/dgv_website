\set ON_ERROR_STOP on

-- Rollback-only proof that the exact sequence operation used by the connector
-- commit is undone when a failure occurs after RESTART.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;

select plan(1);

select lives_ok(
  $test$
  do $body$
  declare
    v_before_last bigint;
    v_before_called boolean;
    v_inside_last bigint;
    v_inside_called boolean;
    v_after_last bigint;
    v_after_called boolean;
    v_restart_with bigint;
    v_message text;
  begin
    select s.last_value::bigint, s.is_called
    into strict v_before_last, v_before_called
    from public.resv_groups_id_seq as s;

    v_restart_with := case
      when v_before_last < 9223372036854775000::bigint then v_before_last + 97
      else v_before_last - 97
    end;

    begin
      execute pg_catalog.format(
        'alter sequence public.resv_groups_id_seq restart with %s',
        v_restart_with
      );

      select s.last_value::bigint, s.is_called
      into strict v_inside_last, v_inside_called
      from public.resv_groups_id_seq as s;
      if v_inside_last is distinct from v_restart_with
         or v_inside_called is distinct from false then
        raise exception 'transactional restart did not take effect before forced failure';
      end if;

      raise exception 'dgv_forced_failure_after_sequence_restart';
    exception
      when others then
        get stacked diagnostics v_message = message_text;
        if v_message <> 'dgv_forced_failure_after_sequence_restart' then
          raise;
        end if;
    end;

    select s.last_value::bigint, s.is_called
    into strict v_after_last, v_after_called
    from public.resv_groups_id_seq as s;
    if v_after_last is distinct from v_before_last
       or v_after_called is distinct from v_before_called then
      raise exception 'sequence RESTART survived the forced subtransaction rollback';
    end if;
  end
  $body$;
  $test$,
  'ALTER SEQUENCE RESTART rolls back after a later connector-style failure'
);

select * from finish();
rollback;
