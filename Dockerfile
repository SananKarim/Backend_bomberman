# NEON BOMBER — authoritative Socket.IO game server
# Build from the REPO ROOT so only server/ code is needed:
#   docker build -f server/Dockerfile -t neon-bomber-server .
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first for layer caching.
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

# Application code (pure lib + rooms + game + ai + entrypoint).
COPY server/ ./

# Cloud Run injects $PORT; the app must bind it.
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
