# Multi-stage build for DOGFOOD 2026 Portal (Node.js 22 LTS Alpine)
FROM node:22-alpine AS builder

WORKDIR /app

# Install all dependencies including devDependencies for build
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy sources and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Install production-only dependencies
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy compiled artifacts, assets, and fixtures
COPY --from=builder /app/dist ./dist
COPY fixtures.json ./fixtures.json
COPY run.py ./run.py
COPY .dogfood.toml ./.dogfood.toml

# Pre-seed the embedded SQLite database so it starts ready offline
RUN node dist/db/seed.js

EXPOSE 8080

CMD ["node", "dist/index.js"]
