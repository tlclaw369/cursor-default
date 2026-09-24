# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV API_BASE_URL=https://api.cloudflare.com/client/v4
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY public ./public
COPY src ./src
COPY tsconfig.json wrangler.jsonc worker-configuration.d.ts ./
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/node-server.ts"]
