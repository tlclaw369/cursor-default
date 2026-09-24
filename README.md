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

## Deploy with Docker Compose

Yes. You can self-host Zoneboard with Docker Compose on your own machine or VPS.

```bash
docker compose up --build -d
```

Then open http://127.0.0.1:8787 and paste your Cloudflare API token.

Optional settings in a `.env` file next to `docker-compose.yml`:

```bash
ZONEBOARD_PORT=8787
API_BASE_URL=https://api.cloudflare.com/client/v4
FORCE_HTTPS=0
```

Set `FORCE_HTTPS=1` only when the app is reached over HTTPS (for example behind a reverse proxy with TLS), so the session cookie is marked Secure.

Try the UI without a live Cloudflare token:

```bash
docker compose -f docker-compose.mock.yml up --build
```

Paste any token that is at least 20 characters. The sample domains are `example.com` and `campaigns.test`.

## Deploy to Cloudflare Workers

```bash
npx wrangler login
npm run deploy
```

Then open the `workers.dev` URL, or attach a custom domain, and connect with the same kind of token.

## Preview without Docker

A local stand-in API is included so the interface can be tried without calling Cloudflare:

```bash
node scripts/mock-cloudflare.mjs
```

In another terminal, point the app at it:

```bash
npx wrangler dev --var API_BASE_URL:http://127.0.0.1:3999/client/v4
```

Or run the same Node server Docker uses:

```bash
API_BASE_URL=http://127.0.0.1:3999/client/v4 npm start
```

## Checks

```bash
npm test
npm run check
```
