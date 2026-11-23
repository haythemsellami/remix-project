FROM node:24.3.0-bookworm-slim@sha256:8225b1806c6e37dced949224b5c0d8278a2fe593967288620e0af69b2cbc4539 AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NX_DAEMON=false \
    NX_NO_CLOUD=true

COPY package.json yarn.lock .nvmrc ./
RUN test "$(node --version)" = "$(cat .nvmrc)" \
    && yarn install --frozen-lockfile --non-interactive --network-timeout 600000

COPY . .
ARG WALLET_CONNECT_PROJECT_ID
RUN yarn build:production \
    && test -s dist/apps/remix-ide/index.html \
    && test -s dist/apps/remix-ide/assets/js/soljson.js

FROM nginx:stable-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3 AS runtime

ENV PORT=8080 \
    NGINX_ENVSUBST_FILTER="^PORT$"

COPY --from=build /app/dist/apps/remix-ide/ /usr/share/nginx/html/
COPY deploy/railway/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
