# Literal

A blank page for your notes. Open it and type: it saves itself. Your notes are one keystroke away (⌘K), and sign-in is only for syncing them between devices.

- **App:** Svelte 5 + Vite, an installable PWA that works fully offline (`app/`).
- **Server:** one Cloudflare Worker (`worker/`): Better Auth on D1 for accounts, and a Durable Object per user that stores their notes and syncs them live.
- **Sync:** every note is a Yjs doc, so edits from any number of devices, online or not, merge without conflicts. The protocol is in `protocol/protocol.ts`.

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars          # then set BETTER_AUTH_SECRET to any long random string
pnpm wrangler d1 migrations apply literal --local --persist-to .wrangler/state
pnpm dev                                # http://localhost:5390
```

One dev server runs the app and the Worker. It sends no email: sign-in codes are printed in the terminal.

```sh
pnpm check   # types: app and worker
pnpm test    # end to end, against a production build served locally (stop `pnpm dev` first: same port)
```

## Deploy

You need a Cloudflare account on the Workers Paid plan, which sending email needs, and a domain on it.

1. `pnpm wrangler login`
2. `pnpm wrangler d1 create literal`, then put the printed `database_id` in `wrangler.jsonc`.
3. `pnpm wrangler email sending enable literal.ink`, so the Worker can email sign-in codes from the domain.
4. In `wrangler.jsonc`, `APP_URL`, `EMAIL_FROM` and the email binding's allowed sender are set for literal.ink: change them for another domain.
5. `pnpm wrangler d1 migrations apply literal --remote`
6. `openssl rand -hex 32 | pnpm wrangler secret put BETTER_AUTH_SECRET`
7. `pnpm run deploy` (not `pnpm deploy`, which is a different pnpm command).
8. In the Cloudflare dashboard: add your domain to the Worker (Settings → Domains & Routes), and turn on Web Analytics for it.
9. Forward `hello@literal.ink`, the contact address in `app/public/privacy.html`, to a real inbox (Email → Email Routing).

## Before launch, check on real devices

The tests run in desktop Chromium. These need a real iPhone and a real Android phone:

- the keyboard on iOS: the end of a long note stays visible above it,
- the notes sheet: drag down to close, swipe a row left to delete,
- installing to the Home Screen, and opening it with no network,
- the sign-in email: it arrives in Gmail, Outlook and iCloud, and not in spam.
