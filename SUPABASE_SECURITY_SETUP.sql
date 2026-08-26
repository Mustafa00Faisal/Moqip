-- MOAQIB 6.1.0 Remediation
-- Manual, reviewable setup script. It is intentionally NOT auto-executed.
-- Take a database backup first. The transaction aborts on incompatible legacy data/schema.

begin;

create table if not exists public.app_data (
    id bigint not null default 1,
    owner_id uuid not null references auth.users(id) on delete cascade,
    data jsonb not null default '{}'::jsonb,
    revision bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (owner_id, id)
);

alter table public.app_data
    add column if not exists id bigint not null default 1,
    add column if not exists owner_id uuid,
    add column if not exists data jsonb,
    add column if not exists revision bigint not null default 0,
    add column if not exists updated_at timestamptz not null default now();

-- Abort with a useful message instead of relying on implicit casts or silently
-- assigning ownership to legacy rows. MOAQIB's client contract uses bigint id=1.
do $$
declare
    incompatible_columns text;
begin
    select string_agg(a.attname || '=' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attname)
    into incompatible_columns
    from pg_attribute a
    where a.attrelid = 'public.app_data'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and (
        (a.attname = 'id' and a.atttypid <> 'bigint'::regtype)
        or (a.attname = 'owner_id' and a.atttypid <> 'uuid'::regtype)
        or (a.attname = 'data' and a.atttypid <> 'jsonb'::regtype)
        or (a.attname = 'revision' and a.atttypid <> 'bigint'::regtype)
        or (a.attname = 'updated_at' and a.atttypid <> 'timestamptz'::regtype)
      );

    if incompatible_columns is not null then
        raise exception 'MOAQIB preflight failed: incompatible app_data columns: %', incompatible_columns;
    end if;

    if exists (
        select 1
        from public.app_data
        where id is null or owner_id is null or data is null
           or revision is null or updated_at is null
    ) then
        raise exception 'MOAQIB preflight failed: app_data contains NULL required values';
    end if;

    if exists (select 1 from public.app_data where id <> 1) then
        raise exception 'MOAQIB preflight failed: app_data contains snapshot ids other than 1';
    end if;

    if exists (select 1 from public.app_data where revision < 0) then
        raise exception 'MOAQIB preflight failed: app_data contains negative revisions';
    end if;

    if exists (select 1 from public.app_data where jsonb_typeof(data) <> 'object') then
        raise exception 'MOAQIB preflight failed: app_data contains non-object JSON snapshots';
    end if;

    if exists (
        select 1
        from public.app_data d
        left join auth.users u on u.id = d.owner_id
        where u.id is null
    ) then
        raise exception 'MOAQIB preflight failed: app_data contains owner_id values absent from auth.users';
    end if;

    if exists (
        select 1
        from public.app_data
        group by owner_id, id
        having count(*) > 1
    ) then
        raise exception 'MOAQIB preflight failed: duplicate (owner_id,id) rows exist';
    end if;

    if exists (
        select 1
        from pg_index i
        where i.indrelid = 'public.app_data'::regclass
          and i.indisunique
          and (
            select array_agg(a.attname::text order by key_column.ordinality)
            from unnest(i.indkey) with ordinality as key_column(attnum, ordinality)
            join pg_attribute a
              on a.attrelid = i.indrelid and a.attnum = key_column.attnum
            where key_column.ordinality <= i.indnkeyatts
          ) = array['id']::text[]
    ) then
        raise exception 'MOAQIB preflight failed: legacy uniqueness on id alone blocks one snapshot per owner';
    end if;
end
$$;

alter table public.app_data
    alter column id set not null,
    alter column id set default 1,
    alter column owner_id set not null,
    alter column data set not null,
    alter column data set default '{}'::jsonb,
    alter column revision set not null,
    alter column revision set default 0,
    alter column updated_at set not null,
    alter column updated_at set default now();

do $$
declare
    existing_definition text;
begin
    if exists (
        select 1
        from pg_constraint
        where conrelid = 'public.app_data'::regclass
          and conname = 'app_data_owner_id_fkey'
    ) then
        select lower(pg_get_constraintdef(oid))
        into existing_definition
        from pg_constraint
        where conrelid = 'public.app_data'::regclass
          and conname = 'app_data_owner_id_fkey';

        if position('foreign key (owner_id) references auth.users(id) on delete cascade' in existing_definition) = 0 then
            raise exception 'MOAQIB preflight failed: app_data_owner_id_fkey has an unexpected definition: %', existing_definition;
        end if;
    else
        alter table public.app_data
            add constraint app_data_owner_id_fkey
            foreign key (owner_id) references auth.users(id)
            on delete cascade not valid;
    end if;
end
$$;

alter table public.app_data validate constraint app_data_owner_id_fkey;

-- Rebuild these dedicated checks instead of trusting an existing object only by name.
alter table public.app_data
    drop constraint if exists app_data_single_snapshot_id_check,
    drop constraint if exists app_data_revision_nonnegative_check,
    drop constraint if exists app_data_json_object_check;

alter table public.app_data
    add constraint app_data_single_snapshot_id_check check (id = 1) not valid,
    add constraint app_data_revision_nonnegative_check check (revision >= 0) not valid,
    add constraint app_data_json_object_check check (jsonb_typeof(data) = 'object') not valid;

alter table public.app_data validate constraint app_data_single_snapshot_id_check;
alter table public.app_data validate constraint app_data_revision_nonnegative_check;
alter table public.app_data validate constraint app_data_json_object_check;

do $$
begin
    if to_regclass('public.app_data_owner_id_id_uidx') is not null and not exists (
        select 1
        from pg_index i
        where i.indexrelid = to_regclass('public.app_data_owner_id_id_uidx')
          and i.indrelid = 'public.app_data'::regclass
          and i.indisunique
          and i.indisvalid
          and i.indpred is null
          and i.indexprs is null
          and (
            select array_agg(a.attname::text order by key_column.ordinality)
            from unnest(i.indkey) with ordinality as key_column(attnum, ordinality)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = key_column.attnum
            where key_column.ordinality <= i.indnkeyatts
          ) = array['owner_id', 'id']::text[]
    ) then
        raise exception 'MOAQIB preflight failed: app_data_owner_id_id_uidx exists with an unexpected definition';
    end if;

    if not exists (
        select 1
        from pg_index i
        where i.indrelid = 'public.app_data'::regclass
          and i.indisunique
          and i.indisvalid
          and i.indpred is null
          and i.indexprs is null
          and (
            select array_agg(a.attname::text order by key_column.ordinality)
            from unnest(i.indkey) with ordinality as key_column(attnum, ordinality)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = key_column.attnum
            where key_column.ordinality <= i.indnkeyatts
          ) = array['owner_id', 'id']::text[]
    ) then
        execute 'create unique index app_data_owner_id_id_uidx on public.app_data (owner_id, id)';
    end if;
end
$$;

-- Server-side guard: even an outdated client cannot bypass optimistic concurrency.
-- Existing legacy rows may start at revision 0; their first 6.1 update must write 1.
create or replace function public.moaqib_enforce_app_data_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        if new.revision <> 1 then
            raise exception 'MOAQIB revision conflict: an inserted snapshot must start at revision 1'
                using errcode = '40001';
        end if;
    elsif new.revision <> old.revision + 1 then
        raise exception 'MOAQIB revision conflict: expected %, received %', old.revision + 1, new.revision
            using errcode = '40001';
    end if;
    return new;
end
$$;

revoke all on function public.moaqib_enforce_app_data_revision() from public, anon, authenticated;

drop trigger if exists moaqib_app_data_revision_guard on public.app_data;
create trigger moaqib_app_data_revision_guard
before insert or update on public.app_data
for each row execute function public.moaqib_enforce_app_data_revision();

alter table public.app_data enable row level security;
alter table public.app_data force row level security;

revoke all on table public.app_data from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.app_data to authenticated;

-- app_data is dedicated to MOAQIB snapshots. Remove every legacy policy first so
-- an older permissive policy cannot remain active alongside the four owner rules.
do $$
declare
    policy_record record;
begin
    for policy_record in
        select policyname
        from pg_policies
        where schemaname = 'public' and tablename = 'app_data'
    loop
        execute format('drop policy %I on public.app_data', policy_record.policyname);
    end loop;
end
$$;

create policy "MOAQIB owners can select their snapshot"
on public.app_data
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "MOAQIB owners can insert their snapshot"
on public.app_data
for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy "MOAQIB owners can update their snapshot"
on public.app_data
for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy "MOAQIB owners can delete their snapshot"
on public.app_data
for delete
to authenticated
using ((select auth.uid()) = owner_id);

commit;

-- Ask PostgREST to refresh its schema cache immediately after the revision column/constraints.
notify pgrst, 'reload schema';

-- Verification queries to run after commit:
--
-- select relrowsecurity, relforcerowsecurity
-- from pg_class
-- where oid = 'public.app_data'::regclass;
--
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'app_data'
-- order by policyname;
--
-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'app_data'
-- order by grantee, privilege_type;
--
-- select owner_id, id, revision, updated_at, jsonb_typeof(data) as data_type
-- from public.app_data
-- order by owner_id;
--
-- select tgname, pg_get_triggerdef(oid)
-- from pg_trigger
-- where tgrelid = 'public.app_data'::regclass and not tgisinternal;
