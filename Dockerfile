# Use Node.js 18 LTS Alpine for smaller image size
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build the TypeScript code
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create a non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/build ./build

# Create directory for any potential file writes (if needed)
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Build-time arguments for environment variables
ARG FITBIT_CLIENT_ID
ARG FITBIT_CLIENT_SECRET
ARG DATABASE_URL
ARG PORT=8080

# Set environment variables
ENV FITBIT_CLIENT_ID=${FITBIT_CLIENT_ID}
ENV FITBIT_CLIENT_SECRET=${FITBIT_CLIENT_SECRET}
ENV DATABASE_URL=${DATABASE_URL}
ENV PORT=${PORT}

# Expose the port
EXPOSE ${PORT}

# Run the HTTP server
CMD ["node", "build/http-server.js"]
