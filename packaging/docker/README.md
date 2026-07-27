# AgencyAI local Docker support

The retained Docker assets support local development and validation only. The
AgencyAI Desktop MVP does not ship hosted account, organization, billing,
provisioning, or cloud-worker services.

## Retained assets

- `Dockerfile` builds the local OpenWork host/runtime used by AgencyAI.
- `Dockerfile.microsandbox` builds the optional local microsandbox image.
- `docker-compose.yml` runs the retained local host stack.
- `docker-compose.dev.yml` supplies development overrides.
- `docker-compose.otel-lgtm.yml` starts the optional local Grafana OTEL-LGTM
  observability backend.
- `microsandbox-entrypoint.sh` starts the microsandbox container.
- `otel-lgtm-validate.sh` validates the local observability backend.

## Local host stack

From the repository root:

```bash
docker compose -f packaging/docker/docker-compose.yml up --build
```

Add development overrides when needed:

```bash
docker compose \
  -f packaging/docker/docker-compose.yml \
  -f packaging/docker/docker-compose.dev.yml \
  up --build
```

Stop the stack without deleting unrelated Docker data:

```bash
docker compose -f packaging/docker/docker-compose.yml down
```

## Local observability backend

`docker-compose.otel-lgtm.yml` starts Grafana's all-in-one development backend
for local traces, logs, and metrics. It is intended for development and tests,
not production retention or security.

```bash
docker compose -f packaging/docker/docker-compose.otel-lgtm.yml up -d --wait
bash packaging/docker/otel-lgtm-validate.sh
```

Open Grafana at `http://127.0.0.1:3000`. The image's default development
credentials are public, so do not expose it to an untrusted network.

## Production boundary

AgencyAI's supported product artifact is the signed desktop application. A
multi-user hosted control plane, remote sandbox fleet, Helm chart, or managed
cloud deployment is outside this MVP and must be designed, licensed, secured,
and operated as a separate product.
