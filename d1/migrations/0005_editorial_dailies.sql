create unique index challenges_ordered_pair_unique_idx
  on challenges (start_page_id, target_page_id, ruleset)
  where start_page_id is not null and target_page_id is not null;

create table daily_nominations (
  id text primary key,
  challenge_id text not null unique references challenges(id),
  nominated_by_account_id text not null,
  nominated_by_display_name text not null,
  status text not null check (status in ('pending', 'approved', 'declined')),
  recognizable_score integer,
  weird_score integer,
  hard_score integer,
  suggested_flavor text check (
    suggested_flavor is null or suggested_flavor in ('recognizable', 'weird', 'hard')
  ),
  confidence text not null check (
    confidence in ('high', 'medium', 'low', 'unclassified')
  ),
  classifier_version text not null,
  reviewed_by_account_id text,
  reviewed_at text,
  created_at text not null,
  updated_at text not null
);

create index daily_nominations_pending_idx
  on daily_nominations (created_at, id)
  where status = 'pending';

create table daily_queue_entries (
  id text primary key,
  challenge_id text not null references challenges(id),
  nomination_id text unique references daily_nominations(id),
  flavor text not null check (flavor in ('recognizable', 'weird', 'hard')),
  source text not null check (source in ('community', 'admin')),
  status text not null check (status in ('queued', 'consumed', 'removed', 'invalid')),
  queued_by_account_id text not null,
  queued_at text not null,
  consumed_daily_date text check (
    consumed_daily_date is null or consumed_daily_date glob '????-??-??'
  ),
  consumed_at text,
  updated_at text not null
);

create unique index daily_queue_entries_one_queued_challenge_idx
  on daily_queue_entries (challenge_id)
  where status = 'queued';

create index daily_queue_entries_queued_fifo_idx
  on daily_queue_entries (flavor, queued_at, id)
  where status = 'queued';

create trigger daily_queue_entries_community_nomination_insert
before insert on daily_queue_entries
for each row
when new.source = 'community' and not exists (
  select 1 from daily_nominations
  where id = new.nomination_id
    and challenge_id = new.challenge_id
    and status = 'approved'
)
BEGIN
  select raise(abort, 'community queue entry requires an approved nomination for the same challenge');
END;

create trigger daily_queue_entries_community_nomination_update
before update of challenge_id, nomination_id, source on daily_queue_entries
for each row
when new.source = 'community' and not exists (
  select 1 from daily_nominations
  where id = new.nomination_id
    and challenge_id = new.challenge_id
    and status = 'approved'
)
BEGIN
  select raise(abort, 'community queue entry requires an approved nomination for the same challenge');
END;

create trigger daily_nominations_community_queue_approval_update
before update of challenge_id, status on daily_nominations
for each row
when exists (
  select 1 from daily_queue_entries
  where nomination_id = new.id
    and source = 'community'
    and (new.challenge_id <> challenge_id or new.status <> 'approved')
)
BEGIN
  select raise(abort, 'community queue entry requires an approved nomination for the same challenge');
END;

create table daily_features (
  daily_date text primary key check (daily_date glob '????-??-??'),
  challenge_id text not null unique references challenges(id),
  flavor text not null check (flavor in ('recognizable', 'weird', 'hard')),
  selection_source text not null check (
    selection_source in ('automatic', 'community', 'admin')
  ),
  queue_entry_id text unique references daily_queue_entries(id),
  selected_by_account_id text,
  classifier_version text not null,
  selected_score integer,
  created_at text not null
);

create trigger daily_features_queue_provenance_insert
before insert on daily_features
for each row
when (new.selection_source = 'automatic' and new.queue_entry_id is not null)
  or (
    new.selection_source in ('community', 'admin')
    and not exists (
      select 1 from daily_queue_entries
      where id = new.queue_entry_id
        and challenge_id = new.challenge_id
        and source = new.selection_source
    )
  )
BEGIN
  select case
    when new.selection_source = 'automatic'
      then raise(abort, 'automatic daily feature cannot reference a queue entry')
    else raise(abort, 'daily feature queue entry must match challenge and selection source')
  END;
END;

create trigger daily_features_queue_provenance_update
before update of challenge_id, selection_source, queue_entry_id on daily_features
for each row
when (new.selection_source = 'automatic' and new.queue_entry_id is not null)
  or (
    new.selection_source in ('community', 'admin')
    and not exists (
      select 1 from daily_queue_entries
      where id = new.queue_entry_id
        and challenge_id = new.challenge_id
        and source = new.selection_source
    )
  )
BEGIN
  select case
    when new.selection_source = 'automatic'
      then raise(abort, 'automatic daily feature cannot reference a queue entry')
    else raise(abort, 'daily feature queue entry must match challenge and selection source')
  END;
END;

create trigger daily_queue_entries_feature_provenance_update
before update of challenge_id, source on daily_queue_entries
for each row
when exists (
  select 1 from daily_features
  where queue_entry_id = new.id
    and (challenge_id <> new.challenge_id or selection_source <> new.source)
)
BEGIN
  select raise(abort, 'daily feature queue entry must match challenge and selection source');
END;

insert into daily_features (
  daily_date,
  challenge_id,
  flavor,
  selection_source,
  classifier_version,
  created_at
)
select
  daily_date,
  id,
  case cast(strftime('%w', daily_date) as integer)
    when 0 then 'hard'
    when 6 then 'hard'
    when 4 then 'weird'
    when 5 then 'weird'
    else 'recognizable'
  END,
  'automatic',
  'legacy-v1',
  created_at
from challenges
where daily_date is not null;
