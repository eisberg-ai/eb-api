-- Normalize messages.content to a JSON array of blocks and enforce block shape.

do $$
declare
  row record;
  text_value text;
  parsed jsonb;
  normalized jsonb;
begin
  if to_regclass('public.messages') is null then
    return;
  end if;

  for row in
    select id, content
      from public.messages
     where content is null or jsonb_typeof(content) <> 'array'
  loop
    normalized := null;
    if row.content is null then
      normalized := '[]'::jsonb;
    elsif jsonb_typeof(row.content) = 'object' then
      normalized := jsonb_build_array(row.content);
    elsif jsonb_typeof(row.content) = 'string' then
      text_value := row.content #>> '{}';
      if text_value is null then
        normalized := '[]'::jsonb;
      else
        begin
          parsed := text_value::jsonb;
          if jsonb_typeof(parsed) = 'array' then
            normalized := parsed;
          elsif jsonb_typeof(parsed) = 'object' then
            normalized := jsonb_build_array(parsed);
          else
            normalized := jsonb_build_array(jsonb_build_object('kind', 'text', 'text', text_value));
          end if;
        exception when others then
          normalized := jsonb_build_array(jsonb_build_object('kind', 'text', 'text', text_value));
        end;
      end if;
    else
      normalized := jsonb_build_array(jsonb_build_object('kind', 'text', 'text', row.content::text));
    end if;

    update public.messages
       set content = normalized
     where id = row.id;
  end loop;
end $$;

create or replace function public.validate_message_content()
returns trigger
language plpgsql
as $$
declare
  elem jsonb;
  kind text;
begin
  if new.content is null or jsonb_typeof(new.content) <> 'array' then
    raise exception 'messages.content must be a json array';
  end if;

  for elem in select * from jsonb_array_elements(new.content)
  loop
    if jsonb_typeof(elem) <> 'object' then
      raise exception 'messages.content must be an array of objects';
    end if;
    kind := elem->>'kind';
    if kind is null then
      raise exception 'messages.content blocks must include kind';
    end if;
    if kind not in ('text', 'code', 'data') then
      raise exception 'messages.content block kind must be text, code, or data';
    end if;
    if kind in ('text', 'code') then
      if jsonb_typeof(elem->'text') <> 'string' then
        raise exception 'text/code blocks require string text field';
      end if;
    elsif kind = 'data' then
      if jsonb_typeof(elem->'data') <> 'object' then
        raise exception 'data blocks require object data field';
      end if;
    end if;
  end loop;

  return new;
end;
$$;

do $$
begin
  if to_regclass('public.messages') is null then
    return;
  end if;
  drop trigger if exists messages_validate_content on public.messages;
  create trigger messages_validate_content
    before insert or update on public.messages
    for each row
    execute function public.validate_message_content();
end $$;
