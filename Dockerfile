# ============
# Build stage
# ============
FROM node:20-slim AS build
WORKDIR /app

# Toolchain + headers para node-canvas (Debian/glibc)
RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl \
  python3 make g++ pkg-config \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3

# Instala deps antes do código (cache melhor)
COPY package*.json ./
RUN npm ci

# Código e configs
COPY prisma ./prisma
COPY tsconfig*.json nest-cli.json* ./
COPY src ./src

# Prisma + build
RUN npx prisma generate
RUN npm run build

# ==============
# Runtime stage
# ==============
FROM node:20-slim AS runtime
WORKDIR /app

# Somente libs de execução (sem -dev)
RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl \
  libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist

EXPOSE 8000
CMD ["sh","-c","npx prisma migrate deploy || true; node dist/main.js"]
