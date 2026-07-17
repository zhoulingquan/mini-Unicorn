# ---- Builder stage: install Python dependencies and the package ----
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

WORKDIR /app

# Install Python dependencies first (cached layer). Hatch reads the custom build
# hook from hatch_build.py even for this metadata-only install.
COPY pyproject.toml README.md LICENSE THIRD_PARTY_NOTICES.md hatch_build.py ./
RUN mkdir -p miniUnicorn && touch miniUnicorn/__init__.py && \
    uv pip install --system --no-cache . && \
    rm -rf miniUnicorn

# Copy the full source and install. The prebuilt miniUnicorn/web/dist/ ships in
# the repo, so no Node.js/bun is required.
COPY miniUnicorn/ miniUnicorn/
RUN uv pip install --system --no-cache .

# ---- Runtime stage: minimal image with only runtime deps ----
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Runtime dependencies: curl for HEALTHCHECK, git for cloning, bubblewrap for
# sandboxing. No openssh-client, no Node.js.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates git bubblewrap && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed Python packages and console scripts from the builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# System-wide git config so SSH GitHub URLs are rewritten to HTTPS regardless of
# the running user (written to /etc/gitconfig, not /root/.gitconfig).
RUN git config --system --add url."https://github.com/".insteadOf ssh://git@github.com/ && \
    git config --system --add url."https://github.com/".insteadOf git@github.com:

# Create non-root user and config directory
RUN useradd -m -u 1000 -s /bin/bash miniUnicorn && \
    mkdir -p /home/miniUnicorn/.miniUnicorn && \
    chown -R miniUnicorn:miniUnicorn /home/miniUnicorn /app

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

USER miniUnicorn
ENV HOME=/home/miniUnicorn

# WebUI/WebSocket channel port
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:8900/health || exit 1

ENTRYPOINT ["entrypoint.sh"]
CMD ["status"]
