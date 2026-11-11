# ─── Stage 1: Build React frontend ───────────────────────────────
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
# npm ci installs exactly the versions in package-lock.json (2026-10-26), so every
# build uses the packages that were tested.
RUN npm ci
COPY frontend/ ./
COPY scripts/frontend-license-notices.cjs /tmp/frontend-license-notices.cjs
RUN npm run build \
    && node /tmp/frontend-license-notices.cjs /app/frontend

# ─── Stage 2: Backend + built frontend ────────────────────────────
FROM node:22-alpine
WORKDIR /app

# p7zip for ZIP/CBZ, libarchive-tools (bsdtar) for general archives, libc6-compat for sharp
# wget + ca-certificates needed to download unrar binary
# sqlite for manual DB inspection/fixes (e.g. unsticking a pack from 'processing')
RUN apk add --no-cache p7zip libarchive-tools libc6-compat wget ca-certificates sqlite

# Download official unrar binary from RARLab — handles all RAR variants including
# older files with non-UTF8 filenames that bsdtar cannot extract
RUN wget -q https://www.rarlab.com/rar/rarlinux-x64-621.tar.gz -O /tmp/rar.tar.gz \
    && tar -xf /tmp/rar.tar.gz -C /tmp \
    && cp /tmp/rar/unrar /usr/local/bin/unrar \
    && chmod +x /usr/local/bin/unrar \
    && mkdir -p /usr/share/doc/unrar \
    && cp /tmp/rar/license.txt /tmp/rar/acknow.txt /tmp/rar/readme.txt /usr/share/doc/unrar/ \
    && rm -rf /tmp/rar*

# Install Python3 + pip + dependencies for enricher scripts
RUN apk add --no-cache python3 py3-pip py3-requests \
  && pip3 install --no-cache-dir --break-system-packages requests pyyaml openai 2>/dev/null || \
     pip3 install --no-cache-dir requests pyyaml openai

# Install backend deps
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy backend source
COPY backend/ ./backend/

# Copy Python scripts
COPY scripts/ ./scripts/

# Copy built frontend
COPY --from=frontend-build /app/frontend/build ./frontend/build

# Preserve project terms and inventory the installed image dependencies.
# Package metadata is an audit aid, not a substitute for license texts or source.
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/omnibus/
COPY licenses/native/ /usr/share/doc/omnibus/native/
RUN node /app/scripts/check-native-notices.cjs
RUN cp /lib/apk/db/installed /usr/share/doc/omnibus/alpine-installed.txt \
    && python3 -m pip list --format=json > /usr/share/doc/omnibus/python-packages.json \
    && node --version > /usr/share/doc/omnibus/node-version.txt \
    && test -s /usr/share/doc/unrar/license.txt \
    && test -s /usr/share/doc/unrar/acknow.txt

# Data directory for SQLite
RUN mkdir -p /appdata

EXPOSE 9810

ENV NODE_ENV=production
ENV DB_PATH=/appdata/omnibus.db
ENV PORT=9810

# Docker marks the container healthy/unhealthy (docker ps, Docker Desktop).
# Unhealthy = server not answering within 10 s, database failing, or the comics
# folder missing/empty, three checks in a row. Status only: Docker does not
# restart an unhealthy container. See docs/BACKUP.md, "Health status".
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-9810}/api/health?strict=1" || exit 1

CMD ["node", "backend/server.js"]
