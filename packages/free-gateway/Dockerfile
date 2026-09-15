# Build from the repository root: docker build -f packages/free-gateway/Dockerfile -t archymedes-free-gateway .
FROM oven/bun:1.3.14-slim AS build
WORKDIR /src
COPY package.json tsconfig.json tsconfig.base.json ./
COPY packages/core/src packages/core/src
COPY packages/free-gateway packages/free-gateway
RUN bun build packages/free-gateway/src/server.ts --target=bun --outfile /out/server.js

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build /out/server.js ./server.js
USER bun
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "server.js"]
