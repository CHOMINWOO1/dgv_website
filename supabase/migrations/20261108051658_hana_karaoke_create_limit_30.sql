-- Owner requested 30 room creations per IP per rolling hour.
-- Filename aligned with hosted migration history after successful application.
-- Change only this guard; preserve global 30/hour, active-room 50, room data,
-- capabilities, queue logic, grants, and all other request/search limits.
do $migration$
declare
  v_definition text;
  v_old constant text := $old$creation_ip_hash = p_ip_hash and created_at > v_now - interval '1 hour') >= 10$old$;
  v_new constant text := $new$creation_ip_hash = p_ip_hash and created_at > v_now - interval '1 hour') >= 30$new$;
begin
  v_definition := pg_get_functiondef('public.hana_karaoke_command(text,text,text,uuid,jsonb,text,boolean)'::regprocedure);
  if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'Expected exactly one karaoke per-IP creation limit of 10; review function before applying';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$migration$;
