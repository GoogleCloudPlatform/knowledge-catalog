---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Post History Type IDs
description: Enumerated types for post history events on Stack Exchange.
tags:
- post history
- enum
- moderation
- schema
- data dump
timestamp: '2026-05-28T23:33:44+00:00'
---

This document defines the enumerated types for various events recorded in the `PostHistory` table, tracking changes and moderation actions on posts across Stack Exchange sites.

- `1`: Initial Title - initial title (questions only)
- `2`: Initial Body - initial post raw body text
- `3`: Initial Tags - initial list of tags (questions only)
- `4`: Edit Title - modified title (questions only)
- `5`: Edit Body - modified post body (raw markdown)
- `6`: Edit Tags - modified list of tags (questions only)
- `7`: Rollback Title - reverted title (questions only)
- `8`: Rollback Body - reverted body (raw markdown)
- `9`: Rollback Tags - reverted list of tags (questions only)
- `10`: Post Closed - post voted to be closed
- `11`: Post Reopened - post voted to be reopened
- `12`: Post Deleted - post voted to be removed
- `13`: Post Undeleted - post voted to be restored
- `14`: Post Locked - post locked by moderator
- `15`: Post Unlocked - post unlocked by moderator
- `16`: Community Owned - post now community owned
- `17`: Post Migrated - post migrated - now replaced by 35/36 (away/here)
- `18`: Question Merged - question merged with deleted question
- `19`: Question Protected - question was protected by a moderator.
- `20`: Question Unprotected - question was unprotected by a moderator.
- `21`: Post Disassociated - OwnerUserId removed from post by admin
- `22`: Question Unmerged - answers/votes restored to previously merged question
- `24`: Suggested Edit Applied
- `25`: Post Tweeted
- `31`: Comment discussion moved to chat
- `33`: Post notice added - `comment` contains foreign key to PostNotices
- `34`: Post notice removed - `comment` contains foreign key to PostNotices
- `35`: Post migrated away - replaces id 17
- `36`: Post migrated here - replaces id 17
- `37`: Post merge source
- `38`: Post merge destination
- `50`: Bumped by Community User
- `52`: Question became hot network question (main) / Hot Meta question (meta)
- `53`: Question removed from hot network/meta questions by a moderator
- `66`: Created from Ask Wizard

## Older Dumps (Likely no longer present)
- `23`: Unknown dev related event
- `26`: Vote nullification by dev (ERM?)
- `27`: Post unmigrated/hidden moderator migration?
- `28`: Unknown suggestion event
- `29`: Unknown moderator event (possibly de-wikification?)
- `30`: Unknown event (too rare to guess)

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
