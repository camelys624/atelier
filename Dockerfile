FROM oven/bun:1.4.4 AS web-build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY vite.config.ts tsconfig.json ./
COPY public ./public
RUN bun run build

FROM python:3.13-slim AS runtime
COPY --from=web-build /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_ENV=production HOST=0.0.0.0 PORT=3080 PYTHON_BIN=python3 DATA_DIR=/app/data
COPY adapter/requirements.txt ./adapter/requirements.txt
RUN pip install --no-cache-dir -r adapter/requirements.txt
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=web-build /app/dist/client ./dist/client
COPY server ./server
COPY adapter ./adapter
RUN useradd --create-home --uid 10001 atelier && mkdir -p /app/data && chown -R atelier:atelier /app
USER atelier
EXPOSE 3080
CMD ["bun", "server/index.ts"]
