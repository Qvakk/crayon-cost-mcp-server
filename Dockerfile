# Use Debian-based image for better canvas/native module compatibility
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libgif-dev \
    libjpeg-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage - use slim for smaller size
FROM node:22-slim

# Install runtime dependencies for canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgif7 \
    libjpeg62-turbo \
    librsvg2-2 \
    fonts-dejavu-core \
    fonts-liberation \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only (canvas will use prebuilt binaries)
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create non-root user and logs directory
RUN groupadd -g 1001 nodejs && \
    useradd -m -u 1001 -g nodejs nodejs && \
    mkdir -p /app/logs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 3003

# Health check using wget (available in slim)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3003/health || exit 1

# Set environment variable for production
ENV NODE_ENV=production
ENV TRANSPORT_MODE=http

# Start the server
CMD ["node", "dist/index.js"]
