FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev \
  && rm -rf /var/lib/apt/lists/* /root/.npm

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime

ARG VCS_REF=unknown
ARG PUBLISH_RUN_NUMBER=0
LABEL org.opencontainers.image.source="https://github.com/Aurea-Ecom-Labs/wpp-vip-ingest" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.version="${VCS_REF}" \
  com.aurea.wpp.publish-run-number="${PUBLISH_RUN_NUMBER}" \
  com.aurea.wpp.database-schema="1" \
  com.aurea.wpp.runtime-state-schema="1"

ENV NODE_ENV=production \
  WPP_RUNTIME_MODE=container \
  WPP_DATA_DIR=/data \
  WPP_SOURCE=/source/source.json
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates util-linux libgcc-s1 libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /source /tmp \
  && chown node:node /data /source /tmp
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
COPY --chown=node:node docker/init-data.sh ./docker/init-data.sh
USER 1000:1000
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD ["worker"]
