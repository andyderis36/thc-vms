# syntax=docker/dockerfile:1
# THC-VMS frontend — standalone production image.
# NEXT_PUBLIC_* is inlined at BUILD time (fetcher.ts reads it in browser
# code), so pass --build-arg at build; compose `environment:` cannot change it.
# Build args are wired in docker-compose.prod.yml.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# BuildKit cache mount: tarball npm bertahan di daemon VPS antar build
# (deploy.sh me-rebuild tiap deploy di host yang sama).
RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund --prefer-offline

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_STORAGE_BASE_URL
ARG NEXT_PUBLIC_APP_NAME="THC Visitor Management System"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3210 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
USER app
EXPOSE 3210
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
