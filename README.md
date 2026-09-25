# Zoneboard

Zoneboard is a small web app for managing Cloudflare domains and DNS records. Optionally, it can also create a Pangolin public HTTP resource on your reverse proxy at the same time.

Tokens stay in HttpOnly browser cookies for the session. They are not saved in the project.

---

## Step by step: GitHub → on-premise client

Use this path to run Zoneboard with Docker Compose on your own machine or VPS, then connect Cloudflare and your on-prem Pangolin.

### 1. Get the code from GitHub

On the server (or your workstation) that will run Zoneboard:

```bash
git clone https://github.com/tlclaw369/cursor-default.git
cd cursor-default
git checkout cursor/pangolin-public-resource-6b13
```

If this branch has already been merged into `main`, you can use `main` instead.

Requirements on that host:

- Docker Engine
- Docker Compose v2 (`docker compose`)

### 2. Prepare a Cloudflare API token

1. Open [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token**.
3. Use the **Edit zone DNS** template.
4. Limit the token to the zones you want Zoneboard to manage (recommended).
5. Create the token and copy it once.

### 3. Prepare your on-prem Pangolin Integration API

On the Pangolin host, enable the Integration API in `config/config.yml`:

```yaml
flags:
  enable_integration_api: true

server:
  integration_port: 3003
```

Expose it through Traefik as `https://api.YOUR_DOMAIN/v1` using the steps in the [Pangolin Integration API docs](https://docs.pangolin.net/self-host/advanced/integration-api).

Restart Pangolin, then confirm:

- Swagger docs open: `https://api.YOUR_DOMAIN/v1/docs`
- API base URL for Zoneboard: `https://api.YOUR_DOMAIN/v1`

In the Pangolin dashboard:

1. Note your [organization ID](https://docs.pangolin.net/manage/organizations/org-id).
2. Go to **Organization → API Keys**.
3. Create an organization API key with permission for **domains**, **sites**, and **public resources**.
4. Copy the key once.
5. Confirm you already have at least one **domain** and one online **site** (Newt connected).

### 4. Configure Zoneboard (optional)

In the Zoneboard repo directory, create a `.env` file:

```bash
ZONEBOARD_PORT=8787
API_BASE_URL=https://api.cloudflare.com/client/v4
FORCE_HTTPS=0
```

Set `FORCE_HTTPS=1` only if you will open Zoneboard over HTTPS (for example behind a reverse proxy with TLS).

### 5. Start Zoneboard with Docker Compose

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f zoneboard
```

Leave logs with `Ctrl+C` when the app is healthy.

Open the client browser:

- Same machine: http://127.0.0.1:8787
- Another machine on the LAN: http://YOUR_SERVER_IP:8787

### 6. Connect Cloudflare in the browser

1. Open Zoneboard.
2. Paste the Cloudflare API token.
3. Click **Connect account**.
4. Confirm your domains appear in the left sidebar.

### 7. Connect Pangolin in the browser

1. Click **Connect Pangolin**.
2. Enter:
   - **API base URL:** `https://api.YOUR_DOMAIN/v1`
   - **Organization ID:** from Pangolin
   - **API key:** the organization key you created
3. Click **Connect Pangolin**.
4. Confirm the status line shows `Pangolin connected`.

### 8. Test DNS + Pangolin together

1. Select a Cloudflare domain.
2. Click **Add record**.
3. Create the DNS record you need (for example `A` or `CNAME` for `app`).
4. Check **Also create a Pangolin public HTTP resource for this hostname**.
5. Fill the Pangolin fields:
   - Resource name
   - Pangolin domain
   - Subdomain (for example `app`, or blank for the base domain)
   - Site
   - Target host or IP on that site (for example `localhost` or an internal IP)
   - Port (for example `8080`)
   - Target method (`http` or `https`)
6. Click **Add record**.

Expected result:

- Cloudflare shows the new DNS record.
- Pangolin shows a new public HTTP resource and target.
- Zoneboard shows a success toast. If Pangolin fails after DNS succeeds, the DNS record is kept and the Pangolin error is shown.

### 9. Optional: remove DNS and Pangolin together

1. Click **Remove** on a DNS record.
2. If Pangolin is connected, check **Also delete the matching Pangolin public resource**.
3. Confirm.

### 10. Stop or update later

Stop:

```bash
docker compose down
```

Update from GitHub and rebuild:

```bash
git pull
docker compose up --build -d
```

---

## Quick reference

### What Zoneboard calls in Pangolin

From the [common API routes](https://docs.pangolin.net/manage/common-api-routes):

- `PUT /org/{orgId}/public-resource` with `mode: "http"`
- `PUT /public-resource/{resourceId}/target` for the site backend

Auth uses a Bearer token per the [Integration API](https://docs.pangolin.net/manage/integration-api).

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Cannot open Zoneboard | `docker compose ps`, firewall/port `8787` |
| Cloudflare connect fails | Token permissions, zone access |
| Pangolin connect fails | Integration API enabled, Traefik route, API key permissions, org ID |
| DNS created, Pangolin failed | Site online, domain verified, target host/port reachable from the site |
| Cookies not sticking on HTTPS | Set `FORCE_HTTPS=1` |

From inside the Zoneboard container, test reachability to Pangolin:

```bash
docker compose exec zoneboard node -e "fetch('https://api.YOUR_DOMAIN/v1/docs').then(r=>console.log(r.status)).catch(e=>console.error(e))"
```

### Dry run without real Cloudflare

```bash
docker compose -f docker-compose.mock.yml up --build
```

Use any token of 20+ characters for Cloudflare. Pangolin still uses your real on-prem API URL in **Connect Pangolin**.

### Local development without Docker

```bash
npm install
npm run dev
```

Or:

```bash
npm start
```

### Deploy to Cloudflare Workers instead

```bash
npx wrangler login
npm run deploy
```

### Checks

```bash
npm test
npm run check
```
