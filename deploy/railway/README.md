# Railway deployment

The `railway-deployment` branch adds hosting configuration to upstream Remix.
The root Dockerfile builds the production bundle with the repository's Node
version and Yarn lockfile, then serves it with Nginx. Monad executes in each
visitor's browser; the service needs no database or persistent volume.

## Railway settings

Create a service in the intended Railway workspace with these settings:

| Setting | Value |
| --- | --- |
| Repository | `haythemsellami/remix-project` |
| Branch | `railway-deployment` |
| Root directory | Repository root |
| Builder | Dockerfile (root `Dockerfile`, detected automatically) |
| Build/start overrides | Leave unset |
| Healthcheck path | `/healthz` |
| Public domain target port | `8080`, with service variable `PORT=8080` |
| Automatic deployments | Disabled initially; deploy selected commits manually |

Generate a Railway domain to enable public HTTPS. The server also supports a
different `PORT` value when the domain's target port matches it. The optional
`WALLET_CONNECT_PROJECT_ID` build argument configures WalletConnect; it is public
frontend configuration and is not required for the local Monad VM.

The production build uses an 8 GiB Node heap limit plus build workers; allow
additional builder memory. The runtime contains only the static assets and
Nginx. Existing Remix remote services retain their upstream configuration.
Browser workspaces belong to the site's origin; export/import them to move from
another hostname.

## Local verification

```sh
docker build -t remix-railway .
docker run --rm -d --name remix-railway -p 127.0.0.1:8088:8080 remix-railway
curl --fail http://127.0.0.1:8088/healthz
```

Open `http://127.0.0.1:8088` and select **Deploy & Run → Environment → Monad VM**.
Deploy and debug a contract on the desired fork. `yarn test:monad:ui` runs the
provider regression tests separately from the container build.
Stop the local server with `docker stop remix-railway`.

## Updating

Fast-forward the fork's `master` to upstream `master`, then merge `master` into
`railway-deployment`. Validate the production build before deploying that commit.
Railway records the deployment's commit SHA and supports rolling back to an
earlier successful deployment. Update the pinned Node image when `.nvmrc` changes.
