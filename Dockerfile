FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY feeds.json ./
COPY src ./src

ENV DATA_PATH=/data/posted.json

CMD ["bun", "run", "src/index.ts"]
