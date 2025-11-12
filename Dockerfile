FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for canvas (including Python)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    fontconfig-dev

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine

# Install canvas dependencies AND build tools for Chart.js rendering
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo \
    cairo-dev \
    pango \
    pango-dev \
    giflib \
    giflib-dev \
    pixman \
    pixman-dev \
    libjpeg-turbo \
    libjpeg-turbo-dev \
    freetype \
    freetype-dev \
    fontconfig \
    fontconfig-dev \
    ttf-dejavu \
    ttf-liberation \
    font-noto

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create non-root user and logs directory
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/logs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 3003

# Set environment variable for production
ENV NODE_ENV=production
ENV TRANSPORT_MODE=http

# Start the server
CMD ["node", "dist/index.js"]
