-- Sign-in codes emailed each day (a UTC date), for the daily limits in worker/src/auth.ts: under "all" across
-- everyone, and under the SHA-256 hex of an address for that address alone. Today's count carries over.
alter table "codesSent" rename to "codesSentByDay";
create table "codesSent" ("day" text not null, "key" text not null, "count" integer not null, primary key ("day", "key"));
insert into "codesSent" ("day", "key", "count") select "day", 'all', "count" from "codesSentByDay";
drop table "codesSentByDay";
