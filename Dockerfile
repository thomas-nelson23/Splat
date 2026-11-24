# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 # Only the glibc x64 Claude Code binary is needed in the image.
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64* \
           node_modules/@anthropic-ai/claude-agent-sdk-darwin-* node_modules/@anthropic-ai/claude-agent-sdk-win32-*

# ---------------------------------------------------------------- runtime
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
# nightly = OpenSCAD development snapshot (Manifold backend, much faster renders); stable = Ubuntu's 2021.01 package
ARG OPENSCAD_CHANNEL=nightly
ARG BOSL2_REF=master
ARG APP_VERSION=dev

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git tini gosu xvfb xauth \
      libgl1 libglu1-mesa libgl1-mesa-dri libxrender1 libxext6 libsm6 libxi6 libxkbcommon0 \
      python3 python3-venv \
      fontconfig fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-roboto-unhinted \
 && rm -rf /var/lib/apt/lists/*

# OpenSCAD: nightly from the official OBS repository, falling back to the Ubuntu package.
RUN set -eux; installed=""; \
    if [ "$OPENSCAD_CHANNEL" = "nightly" ]; then \
      install -d /etc/apt/keyrings; \
      if curl -fsSL https://files.openscad.org/OBS-Repository-Key.pub | gpg --dearmor -o /etc/apt/keyrings/openscad.gpg; then \
        echo "deb [signed-by=/etc/apt/keyrings/openscad.gpg] https://download.opensuse.org/repositories/home:/t-paul/xUbuntu_24.04/ ./" > /etc/apt/sources.list.d/openscad.list; \
        if apt-get update && apt-get install -y --no-install-recommends openscad-nightly; then \
          ln -sf "$(command -v openscad-nightly)" /usr/local/bin/openscad; installed=nightly; \
        else rm -f /etc/apt/sources.list.d/openscad.list; fi; \
      fi; \
    fi; \
    if [ -z "$installed" ]; then apt-get update && apt-get install -y --no-install-recommends openscad; fi; \
    rm -rf /var/lib/apt/lists/*; \
    openscad --version

# OpenSCAD libraries
RUN set -eux; mkdir -p /opt/openscad-libs; \
    git clone --depth 1 --branch "$BOSL2_REF" https://github.com/BelfrySCAD/BOSL2.git /opt/openscad-libs/BOSL2; \
    git clone --depth 1 https://github.com/openscad/MCAD.git /opt/openscad-libs/MCAD; \
    rm -rf /opt/openscad-libs/*/.git

# Python tools for STEP / OBJ / 3MF conversion
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir cadquery-ocp trimesh numpy networkx lxml \
 && /opt/venv/bin/python -c "import OCP, trimesh"

COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY scripts scripts
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DATA_DIR=/data \
    PORT=8080 \
    HOME=/data/home \
    OPENSCAD_LIBS=/opt/openscad-libs \
    PYTHON=/opt/venv/bin/python \
    PATH=/opt/venv/bin:$PATH \
    APP_VERSION=$APP_VERSION \
    PUID=99 \
    PGID=100 \
    NODE_ENV=production

LABEL org.opencontainers.image.title="Splat" \
      org.opencontainers.image.description="Chat with Claude to design OpenSCAD models, with live 3D preview and export" \
      org.opencontainers.image.source="https://github.com/thomas-nelson23/splat" \
      net.unraid.docker.webui="http://[IP]:[PORT:8080]/" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/thomas-nelson23/splat/main/unraid/icon.png"

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "/app/server/dist/index.js"]
