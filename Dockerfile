# One image for both services: SERVICE=runner (default) or SERVICE=queue.
# The runtime is downloaded at build time from the pinned public site commit and checked against runtime.lock.json.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json runtime.lock.json ./
COPY scripts ./scripts
COPY lib ./lib
COPY services ./services
COPY examples ./examples
RUN node scripts/fetch-runtime.mjs && node scripts/fetch-runtime.mjs --verify
RUN useradd --create-home --uid 10001 apklab && mkdir -p /data && chown apklab /data
USER apklab
ENV SERVICE=runner RUNNER_HOST=0.0.0.0 QUEUE_HOST=0.0.0.0 QUEUE_DATA_DIR=/data/queue
EXPOSE 8080 8081
CMD ["sh", "-c", "exec node services/$SERVICE/server.mjs"]
