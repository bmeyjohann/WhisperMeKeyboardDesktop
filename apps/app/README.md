# create-svelte

Everything you need to build a Svelte project, powered by [`create-svelte`](https://github.com/sveltejs/kit/tree/main/packages/create-svelte).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```bash
# create a new project in the current directory
npm create svelte@latest

# create a new project in my-app
npm create svelte@latest my-app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```bash
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```bash
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://kit.svelte.dev/docs/adapters) for your target environment.

## Desktop personalization

Voice settings (`/settings/transcription`) keep dictionary use, writing preferences, and AI suggestion offers independently off by default. Dictionary entries and existing writing profiles remain device-local. Account writing rules use the authenticated native `/preferences` API. Saving either kind keeps the enable switches unchanged. Inferred suggestions are editable drafts and require an explicit Save. `requiresConfirmation: true` is a separate notice-only protocol marker that suppresses insertion; ordinary correction suggestions still insert their edits when the marker is absent or false. Legacy confirmations lock the captured app scope; newer control drafts can unlock the scope with `scopeLocked: false` and the `supportsScopedPreferenceConfirmation` capability.

App mappings use the fixed catalog: Personal/social, Business/work, Development, Writing/publishing, Notes/planning, Study/learning, and Other. Existing free-form category mappings and profiles remain usable locally and can be migrated through the picker. Only canonical IDs are sent as `appCategory`. Style extraction accepts up to five transient examples totaling 12,000 characters and presents editable instructions and an app/category/all-apps recommendation before Save. Examples are not stored in profiles or session history.

Dictionary saves enforce 100 entries, 80 characters per entry, and 4,096 UTF-8 bytes. Writing rules enforce 2,000 characters and 8,000 bytes individually, 100 saved rules and 64,000 saved bytes, and 16,000 active bytes. Token counts are approximate at four bytes per token; byte caps are exact. The server also enforces account and active rule budgets. Run `pnpm test:voice`, `pnpm check`, and `pnpm build` in `apps/app`; native verification uses `cargo check --locked --offline --manifest-path src-tauri/Cargo.toml`.

## Auth0 configuration

The desktop app uses Auth0 for login. When updating credentials, keep the values in `src/lib/services/auth0.ts` in sync with the Android app and Cloudflare Worker:

- **Domain:** `dev-v6bfenyhz8m15z6j.eu.auth0.com`
- **Client ID:** `Nobjj5cwIKiVfUP2iSfIVVRuouNUqlno`
- **Audience:** `https://whisperme.app/api`
- **Scopes:** `openid profile email offline_access`

For silent renewal, enable **Allow Offline Access** on the API matching the audience and **Refresh Token** in the desktop application's grant types. Requesting `offline_access` alone does not guarantee issuance. After correcting Auth0 configuration, sign in again and verify refresh-token presence without logging token values. Expired sessions without a refresh token are cleared and remain signed out until a successful login; periodic checks do not repeatedly attempt an impossible refresh. Temporary network failures remain retryable and retain credentials.

The desktop exchanges authorization codes and refresh tokens through the fixed Auth0 endpoint in `src-tauri/src/auth.rs`. This native request intentionally has no browser `Origin` header: the generic Tauri HTTP plugin adds one, causing Auth0 to withhold non-rotating refresh tokens. Both grants have a five-second transport timeout and do not follow redirects.

If you rotate any of these, adjust the constants in both the Auth0 service and native token transport and redeploy both desktop and backend components.
