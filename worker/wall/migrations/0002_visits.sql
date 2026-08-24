-- Visits, one row per UTC day.
--
-- Analytics Engine already knows this and cannot be asked: it keeps rows for
-- three months, so "since launch" read from it would quietly become "since
-- three months ago" on the ninetieth day, and the number would start going
-- *down*. So the daily figure is copied into D1 while it still exists, and the
-- total is a sum over this table. Cheap to keep — one row a day is 365 rows a
-- year — and it is the only record of the wall's traffic that outlives the
-- retention window.
--
-- `day` is days since the epoch, UTC, which is the same arithmetic `dayOf` in
-- `pulse.ts` uses to rotate a pseudonym. Integer rather than a date string
-- because it is a key, not a label, and because the two would eventually
-- disagree about what a day is.
--
-- `visitors` is distinct pseudonyms on that day. Summing days means somebody
-- who came on Monday and again on Friday counts twice, which is why the number
-- is called visits: it is a count of days-somebody-showed-up, not a count of
-- people. Counting distinct people across all time is not possible here by
-- construction — the pseudonym rotates at midnight precisely so that it cannot
-- be joined across days — and that is the trade the privacy note makes.
CREATE TABLE visit_days (
  day INTEGER NOT NULL PRIMARY KEY,
  visitors INTEGER NOT NULL
);
