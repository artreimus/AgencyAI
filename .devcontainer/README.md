# AgencyAI Desktop Dev Container

This environment runs the real local Electron application in a cloud sandbox.
Use noVNC to see the window and CDP to drive it. It does not start or connect
to an OpenWork Cloud control plane.

## Services

| Service | Port | Description |
|---|---:|---|
| Desktop App (noVNC) | 6080 | Electron rendered in a virtual display |
| Vite HMR | 5173 | React development server |
| CDP Debug | 9825 | Browser and application automation |

## Daytona quick start

```bash
bash .devcontainer/create-daytona-openwork-snapshot.sh
bash .devcontainer/test-on-daytona.sh [branch-or-commit]
```

The helper creates a sandbox from the reusable `agencyai-eval-vnc` snapshot,
checks out the requested ref, installs dependencies only when necessary, starts
XFCE/noVNC, Vite, and Electron, then prints the noVNC and CDP URLs.

For provider evals, populate the reusable secrets volume once:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken
bash .devcontainer/setup-daytona-secrets-volume.sh .anthropic anthropic.env
```

Future sandboxes mount `agencyai-eval-secrets:/daytona-secrets` and source
`/daytona-secrets/*.env` before Electron starts. Never commit those files.

For downloadable evidence or optional video recording:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video
```

The artifacts path mounts `agencyai-eval-artifacts:/daytona-artifacts`, serves
it on port 8090, and stores screenshots and finalized recordings there.

## How it works

1. `Dockerfile.daytona-vnc` starts from Daytona's desktop sandbox image.
2. `create-daytona-openwork-snapshot.sh` creates `agencyai-eval-vnc` without
   baking `node_modules`.
3. `start-daytona-vnc.sh` starts Xvfb, XFCE, x11vnc, and noVNC on display
   `:99`.
4. `test-on-daytona.sh` checks out the requested AgencyAI ref and uses a
   workspace-local pnpm store.
5. `start-daytona-electron.sh` starts the local desktop application with CDP.

## Validation evidence

- Use CDP assertions against port 9825 for application state and user-visible
  behavior.
- Capture screenshots after important states with
  `.devcontainer/capture-daytona-screenshot.sh`.
- Use recordings only when motion matters, then stop them through
  `.devcontainer/stop-daytona-recording.sh` so ffmpeg finalizes the file.

The retained Daytona skills cover local Electron testing, CDP, secrets, and
recording artifacts. Cloud-server and hosted-control-plane skills are not part
of this product branch.
