-- How many sign-in codes were emailed each day (a UTC date), for the daily limit in server/auth.ts.
create table "codesSent" ("day" text not null primary key, "count" integer not null);
