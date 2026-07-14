alter table challenges add column created_by_account_id text;
alter table challenges add column created_by_display_name text;
alter table challenges add column created_by_identity_status text check (
  created_by_identity_status in ('ghost', 'claimed', 'merged')
);

update challenges
set
  created_by_account_id = 'c02875a7-0470-5ef3-b87a-38abcbdcd952',
  created_by_display_name = 'theonenonlyvj',
  created_by_identity_status = 'claimed'
where created_by_account_id is null;
