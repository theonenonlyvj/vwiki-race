# VGames Account Gate And Central Daily Design

## Goal

Make the pre-race identity choice direct and consistent with the shared VGames
platform, while generating exactly one numbered daily challenge at 5:00 AM
Central Time.

## Account Gate

The identity prompt appears only when a player starts a challenge without a
claimed VGames session. Claimed sessions start immediately. Returning ghosts
see the prompt before every challenge until they create an account or log in.

The mode order is:

1. `Guest`
2. `Create New`
3. `Log In / Existing`

`Create New` is selected by default. The dialog identifies the account as a
VGames account and uses the shared copy: "Free, no email - keeps your name and
stats on every device. One account works across all V games."

Creating an account has one `VGames username` field. That username is also the
public display name across VGames. It requires two password fields, and the
client blocks submission unless they match. Username and password shape rules
match VGames: lowercase letters, numbers, and underscores; 3-20 characters;
password 6-128 characters.

VGames remains authoritative for uniqueness. `/auth/set-credentials` performs
the atomic username claim and updates both `username` and `display_name` in the
same statement. A uniqueness conflict returns `username_taken`. The current
ghost account is upgraded in place, preserving its runs and stats.

Guest names remain free-form public nicknames. `/auth/quick` rejects a new
guest name when its case-insensitive normalized value matches a registered
VGames username, returning `name_reserved`. Duplicate names among unclaimed
ghosts remain allowed because they do not confer ownership. Existing devices
silently re-authenticate their own ghost even if its old display name later
became reserved.

Logging in uses the existing VGames login flow. When the device has a ghost,
VGames' existing fold behavior carries those stats into the claimed account.

## Error Handling

- `username_taken`: "That VGames username is already taken."
- `name_reserved`: "That name belongs to an existing VGames account. Choose
  another guest name or log in."
- Password mismatch is caught locally before any request.
- Invalid or expired stored sessions clear silently during idle recovery and
  leave the player as Guest; starting a challenge then opens the account gate.
- Identity outages remain visible errors and do not erase a potentially valid
  session.

## Daily Challenge Time

The product timezone is `America/Chicago`. Cloudflare cron expressions are UTC
and cannot follow daylight-saving time. The Worker therefore receives triggers
at both possible UTC equivalents of 5:00 AM Central:

- `0 10 * * *` for Central Daylight Time
- `0 11 * * *` for Central Standard Time

Before touching D1, the scheduled handler formats the event timestamp in
`America/Chicago` and proceeds only when the local hour/minute is exactly
`05:00`. The Central local calendar date becomes the daily job key. The other
UTC trigger exits without reads, writes, or Wikipedia requests.

The existing D1 lease, unique daily date, and global challenge number sequence
remain unchanged. If Challenge #15 already exists, the accepted daily is
Challenge #16 regardless of its date.

## Rollout

1. Deploy the backward-compatible VGames identity changes first.
2. Deploy the VWiki Worker service binding, identity proxy behavior, and daily
   schedule.
3. Deploy the VWiki Pages dialog.
4. Smoke-test guest reservation, account creation, login, stale-session
   recovery, and the scheduler's summer/winter gates.

