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

One dev server runs the app and the Worker. Without `RESEND_API_KEY`, sign-in codes are printed in the terminal.

```sh
pnpm check   # types: app and worker
pnpm test    # end to end, against a production build served locally (stop `pnpm dev` first: same port)
```

## Deploy

You need a Cloudflare account, a domain on it, and a [Resend](https://resend.com) account for the code emails.

1. `pnpm wrangler login`
2. `pnpm wrangler d1 create literal`, then put the printed `database_id` in `wrangler.jsonc`.
3. In `wrangler.jsonc`, `APP_URL` and `EMAIL_FROM` are set for literal.ink: change them for another domain. The sender's domain must be verified in Resend.
4. `pnpm wrangler d1 migrations apply literal --remote`
5. Secrets:
   ```sh
   openssl rand -hex 32 | pnpm wrangler secret put BETTER_AUTH_SECRET
   pnpm wrangler secret put RESEND_API_KEY
   ```
6. `pnpm run deploy` (not `pnpm deploy`, which is a different pnpm command).
7. In the Cloudflare dashboard: add your domain to the Worker (Settings → Domains & Routes), and turn on Web Analytics for it.
8. Forward `hello@literal.ink`, the contact address in `app/public/privacy.html`, to a real inbox (Email → Email Routing).

### Google and Apple sign-in (optional)

The buttons appear once the keys are set.

- **Google:** create an OAuth client (Web application) with the redirect URI `https://<your domain>/api/auth/callback/google`, then `wrangler secret put` `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **Apple:** create a Services ID with the return URL `https://<your domain>/api/auth/callback/apple`, and generate its client secret (a signed JWT, valid at most 6 months: renew it before it expires). Then `wrangler secret put` `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET`.

## Before launch, check on real devices

The tests run in desktop Chromium. These need a real iPhone and a real Android phone:

- the keyboard on iOS: the end of a long note stays visible above it,
- the notes sheet: drag down to close, swipe a row left to delete,
- installing to the Home Screen, and opening it with no network,
- signing in with Apple from the installed app (redirects can bounce out to Safari).
