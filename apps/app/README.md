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

## Auth0 configuration

The desktop app uses Auth0 for login. When updating credentials, keep the values in `src/lib/services/auth0.ts` in sync with the Android app and Cloudflare Worker:

- **Domain:** `dev-v6bfenyhz8m15z6j.eu.auth0.com`
- **Client ID:** `Nobjj5cwIKiVfUP2iSfIVVRuouNUqlno`
- **Audience:** `https://whisperme.app/api`
- **Scopes:** `openid profile email offline_access`

If you rotate any of these, adjust the constants in the Auth0 service and redeploy both desktop and backend components.
