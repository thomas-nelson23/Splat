<p align="center"><img src="unraid/icon.png" width="96" alt=""></p>

# Splat

Design 3D-printable parts by chatting with Claude. Splat is a self-hosted web app (one Docker container) where Claude Code, running inside the container, writes and edits OpenSCAD for you while a live 3D preview updates next to the chat. [Hermes Agent](https://hermes-agent.nousresearch.com/) can be used instead of Claude Code (see [Using Hermes](#using-hermes-instead-of-claude-code)).

- **Chat to model.** Describe a part, attach a sketch or a picture of the current view, ask for changes. Claude writes parametric OpenSCAD, renders it, looks at the result from several angles and fixes problems before it answers.
- **Live preview.** Every file change re-renders automatically (Manifold backend, so most parts render in well under a second). Orbit, standard views, edges, wireframe, section cut, bounding box, volume.
- **Parameters.** Customizer-style sliders generated from the code (`wall = 2; // [0.8:0.2:5]`). Tweak, preview, then save as the new defaults.
- **Code editor.** Edit by hand any time (OpenSCAD highlighting, autosave, Ctrl+S saves a version).
- **Version history.** Every project is a git repository. Each Claude turn, edit, import and parameter change is a version you can preview, diff and restore.
- **Import.** STL, 3MF, OBJ, PLY, glTF, STEP (converted to mesh), SVG, DXF, PNG heightmaps, fonts and other .scad files. Drop them anywhere on the workspace.
- **Export.** 3MF, STL (binary/ASCII), STEP, OBJ, glTF/GLB, PLY, OFF, AMF, SVG, DXF, PDF, PNG renders and a zip of the source. 3MF is the recommended format for OrcaSlicer, with an "Open in OrcaSlicer" link as well.
- **Libraries.** BOSL2 and MCAD are built in. Put more libraries in `appdata/splat/libraries`.

## Install on Unraid

1. Download the template to your flash drive (Unraid terminal):

   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/my-Splat.xml \
     https://raw.githubusercontent.com/thomas-nelson23/splat/main/unraid/splat.xml
   ```

2. Docker tab → **Add Container** → pick **Splat** from the template list.
3. Fill in what you want (all optional), then **Apply**:
   - **App password**: recommended, especially when exposed through a Cloudflare tunnel.
   - **Claude subscription token** or **Anthropic API key**: or leave blank and paste one into the app's Settings later.
4. Open the web UI from the container's icon.

Updates: every push to `main` publishes `ghcr.io/thomas-nelson23/splat:latest`. Unraid shows "update ready" on the Docker tab; click it to pull the new image (or let the CA Auto Update plugin do it). Releases tagged `v1.2.3` also publish `:1.2.3` and `:1.2` if you prefer to pin.

> The image and icon URLs above are public only if the GitHub repository and the GHCR package are public. For a private repo, make the package public (GitHub → Packages → splat → Package settings → Change visibility) or log Unraid in to ghcr.io with a personal access token.

## Connecting Claude

Settings → Claude connection takes either:

- **Claude subscription token**: on any computer with Claude Code installed run `claude setup-token`, sign in, and paste the `sk-ant-oat…` token. Usage counts against your Pro/Max plan.
- **Anthropic API key** (`sk-ant-api…`) from console.anthropic.com: pay per use.

Values saved in Settings take priority over the container variables. Use **Test connection** to check.

Claude runs with full permissions inside the container (it can edit files and run commands there, and nothing outside the container and the `/data` volume). That is what makes it frictionless; it is also why the app password and a Cloudflare Access policy are a good idea if the app is reachable from the internet.

## Using Hermes instead of Claude Code

Splat can send the chat to a [Hermes Agent](https://hermes-agent.nousresearch.com/) gateway instead of running Claude Code. Settings → Assistant → **Hermes**, then fill in the gateway URL and API key (or set `SPLAT_AGENT=hermes`, `HERMES_URL` and `HERMES_API_KEY` on the container).

On the machine or container that runs Hermes, turn on its OpenAI-compatible API server in `~/.hermes/.env` and start the gateway:

```sh
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random string>   # the same value goes into Splat
API_SERVER_HOST=0.0.0.0                 # only if Splat reaches Hermes over the Docker network
# then: hermes gateway                   (listens on port 8642)
```

How it works: Hermes keeps running wherever it lives and never needs access to Splat's files. Each turn Splat sends the project's current source files with the message; Hermes replies with whole files in fenced blocks (```` ```openscad file=main.scad ````), and Splat writes them, renders, saves a version and, if OpenSCAD reports errors, sends them back for up to three automatic fix attempts. Hermes's own tool use (web search and so on) shows up in the chat as it happens. Each Splat project gets its own Hermes session id (`X-Hermes-Session-Id`), reset by **New chat**.

Differences from Claude Code: Hermes edits only through those file blocks (no shell inside Splat's container), and it does not get the snapshot pictures of the model, so visual checks are up to you.

## Data layout (`/data` → `/mnt/user/appdata/splat`)

```
projects/<project>/        one git repository per project
  main.scad                the model the preview shows (configurable)
  assets/                  imported files
  project.json
  .splat/                  chat log, preview cache, thumbnails (not versioned)
projects/.trash/           deleted projects, recoverable
libraries/                 your own OpenSCAD libraries (on OPENSCADPATH)
home/                      Claude Code's config and session state
settings.json              app settings (credentials stored with 0600 permissions)
```

## OrcaSlicer

Use **Export → Download 3MF** and open it in OrcaSlicer. **Open in OrcaSlicer** hands OrcaSlicer a short-lived download link via its `orcaslicer://` URL scheme; that only works when the computer running OrcaSlicer can reach the server directly (for example on your LAN, not behind Cloudflare Access).

## Container variables

| Variable | Default | |
|---|---|---|
| `APP_PASSWORD` | (none) | Password for the web UI |
| `CLAUDE_CODE_OAUTH_TOKEN` | | Subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | | API key |
| `CLAUDE_MODEL` | Claude Code default | e.g. `opus`, `sonnet` |
| `SPLAT_AGENT` | `claude` | `hermes` to use a Hermes Agent gateway for the chat |
| `HERMES_URL` | | Hermes API server, e.g. `http://hermes:8642` |
| `HERMES_API_KEY` | | The gateway's `API_SERVER_KEY` |
| `HERMES_MODEL` | gateway default | Optional model override sent to Hermes |
| `RENDER_TIMEOUT_SECONDS` | 600 | Max time for one render |
| `PUID` / `PGID` | 99 / 100 | Owner of files in `/data` |
| `PORT` | 8080 | |

## Development

```sh
npm install
DATA_DIR=./data npm run dev:server   # API on :8080 (needs openscad, git, python3 with trimesh + cadquery-ocp)
npm run dev:web                      # Vite on :5173, proxies to :8080
```

The interface follows the Steeze design system (dark ocean-blue field with a hexagon grid, chamfered controls, Geist Mono labels, IBM Plex Sans text, one electric cyan). Its tokens and fonts are vendored in `web/src/steeze/`; `web/src/styles.css` applies them to Splat's components.

Stack: Node 22 + Express + WebSocket server (TypeScript), the Claude Agent SDK (Claude Code) with two custom tools (`render`, `snapshot`) or a Hermes Agent gateway over its OpenAI-compatible API, React + three.js + CodeMirror front end, OpenSCAD nightly, Python (OCP + trimesh) for STEP and mesh conversion.
