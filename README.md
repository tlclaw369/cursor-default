# Zoneboard

Zoneboard is a small web app for a Cloudflare account. Connect an API token, browse every domain the token can see, and add, edit, or remove DNS records.

The token stays in an HttpOnly cookie for this browser. It is not saved in the project, and the page never sends it anywhere except this app, which calls the Cloudflare API for you.

## Create a token

1. Open [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Choose **Create Token**, then the **Edit zone DNS** template.
3. Limit it to the zones you want Zoneboard to manage, if you do not want it to see the whole account.
4. Create the token and copy it. Cloudflare shows the secret only once.

That template includes permission to read zones and edit DNS records, which is what this app uses.

## Run it locally

```bash
npm install
npm run dev
```

Open the URL Wrangler prints (usually http://127.0.0.1:8787) and paste the token.

## Deploy

```bash
npx wrangler login
npm run deploy
```

Then open the `workers.dev` URL, or attach a custom domain, and connect with the same kind of token.

## Preview without a live token

A local stand-in API is included so the interface can be tried without calling Cloudflare:

```bash
node scripts/mock-cloudflare.mjs
```

In another terminal, point the app at it:

```bash
npx wrangler dev --var API_BASE_URL:http://127.0.0.1:3999/client/v4
```

Paste any token that is at least 20 characters. The sample domains are `example.com` and `campaigns.test`.

## Checks

```bash
npm test
npm run check
```
