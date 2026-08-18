# Warehouse Backend - Railway Deployment
FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache curl dumb-init

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install, not ci, for Railway)
RUN npm install

# Copy source files
COPY tsconfig.json ./
COPY src/ ./src/

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Use dumb-init to handle signals
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["npm", "start"]
