alter table challenges add column start_page_id integer check (start_page_id > 0);
alter table challenges add column target_page_id integer check (target_page_id > 0);
alter table challenges add column validation_status text check (
  validation_status in ('pending', 'ready', 'disabled')
);

alter table runs add column start_page_id integer check (start_page_id > 0);
alter table runs add column target_page_id integer check (target_page_id > 0);
alter table runs add column last_page_id integer check (last_page_id > 0);
alter table runs add column last_title text;
alter table runs add column expires_at text;
alter table runs add column wall_elapsed_ms integer check (wall_elapsed_ms >= 0);
alter table runs add column canonical_account_id text;
alter table runs add column ranked_eligible integer not null default 0 check (
  ranked_eligible in (0, 1)
);
alter table runs add column protocol_version integer not null default 1 check (
  protocol_version in (1, 2)
);

alter table run_events add column client_event_id text;
alter table run_events add column request_fingerprint text;
alter table run_events add column source_page_id integer check (source_page_id > 0);
alter table run_events add column source_revision_id integer check (source_revision_id > 0);
alter table run_events add column response_click_count integer check (
  response_click_count >= 0
);
alter table run_events add column response_run_status text check (
  response_run_status in ('active', 'completed')
);
alter table run_events add column response_completed_at text;
alter table run_events add column response_elapsed_ms integer check (
  response_elapsed_ms >= 0
);

create unique index if not exists run_events_run_client_event_idx
  on run_events (run_id, client_event_id)
  where client_event_id is not null;

create unique index if not exists run_path_steps_run_step_unique_idx
  on run_path_steps (run_id, step_number);

create table account_aliases (
  alias_account_id text primary key,
  canonical_account_id text not null,
  updated_at text not null,
  check (alias_account_id <> canonical_account_id)
);

create index account_aliases_canonical_idx
  on account_aliases (canonical_account_id);

create table operation_idempotency (
  operation text not null,
  idempotency_key text not null,
  canonical_account_id text not null,
  request_fingerprint text not null,
  resource_id text,
  outcome_status text not null check (
    outcome_status in ('pending', 'accepted', 'rejected')
  ),
  response_json text,
  error_code text,
  created_at text not null,
  primary key (operation, idempotency_key)
);

create index operation_idempotency_account_created_idx
  on operation_idempotency (canonical_account_id, created_at);

create index runs_ranked_challenge_score_idx
  on runs (
    challenge_id,
    ranked_eligible,
    status,
    elapsed_ms,
    click_count,
    completed_at,
    id
  );

create index runs_ranked_account_challenge_score_idx
  on runs (
    canonical_account_id,
    challenge_id,
    ranked_eligible,
    status,
    elapsed_ms,
    click_count,
    completed_at,
    id
  );

update runs
set
  status = 'abandoned',
  abandoned_at = coalesce(abandoned_at, updated_at, started_at),
  ranked_eligible = 0
where status = 'active';

update runs
set ranked_eligible = 0
where status = 'completed';

create unique index if not exists runs_one_active_canonical_account_idx
  on runs (coalesce(canonical_account_id, account_id))
  where status = 'active';

insert into challenges (
  id, label, start_title, target_title, ruleset, sort_order, is_active,
  created_at, created_by_account_id, created_by_display_name,
  created_by_identity_status
)
select
  'challenge-0002', 'Challenge #2', 'Maraba coffee',
  'Moon landing conspiracy theories', 'ranked_classic',
  (select coalesce(max(sort_order), 0) + 1 from challenges),
  0, '2026-07-14T00:00:00.000Z',
  'c02875a7-0470-5ef3-b87a-38abcbdcd952', 'theonenonlyvj', 'claimed'
where not exists (select 1 from challenges where id = 'challenge-0002');

insert into challenges (
  id, label, start_title, target_title, ruleset, sort_order, is_active,
  created_at, created_by_account_id, created_by_display_name,
  created_by_identity_status
)
select
  'challenge-0003', 'Challenge #3', 'FedEx', 'Vladimir Lenin',
  'ranked_classic',
  (select coalesce(max(sort_order), 0) + 1 from challenges), 0,
  '2026-07-14T00:00:00.000Z',
  'c02875a7-0470-5ef3-b87a-38abcbdcd952', 'theonenonlyvj', 'claimed'
where not exists (select 1 from challenges where id = 'challenge-0003');

update challenges
set is_active = 0, validation_status = 'disabled'
where id not in ('challenge-0001', 'challenge-0002', 'challenge-0003');

UPDATE challenges SET start_page_id=19331, target_page_id=38579,
  start_title='Moon', target_title='Gravity', validation_status='ready'
WHERE id='challenge-0001';
UPDATE challenges SET start_page_id=5478840, target_page_id=80740,
  start_title='Maraba coffee', target_title='Moon landing conspiracy theories', validation_status='ready'
WHERE id='challenge-0002';
UPDATE challenges SET start_page_id=77543, target_page_id=11015252,
  start_title='FedEx', target_title='Vladimir Lenin', validation_status='ready'
WHERE id='challenge-0003';

update challenges
set is_active = 1
where id in ('challenge-0001', 'challenge-0002', 'challenge-0003');

-- Verification: each query must return 0 except ready_active_count, which returns 3.
-- select count(*) as ready_active_count from challenges
-- where is_active = 1 and validation_status = 'ready';
-- select count(*) from challenges where is_active = 1
-- and id not in ('challenge-0001', 'challenge-0002', 'challenge-0003');
-- select count(*) from runs where status = 'active' and protocol_version = 1;
-- select count(*) from runs where status = 'completed'
-- and protocol_version = 1 and ranked_eligible = 1;
