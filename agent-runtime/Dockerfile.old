# E2B Base Image - Full Ubuntu 22.04 environment
FROM ubuntu:22.04

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# Install essential tools
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    jq \
    git \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright system dependencies (for browser automation)
RUN npx playwright install-deps chromium || true

# Create workspace directory
RUN mkdir -p /workspace/agent-runtime

# Copy package files
COPY package*.json /workspace/agent-runtime/
COPY tsconfig.json /workspace/agent-runtime/

# Install dependencies (includes Claude Agent SDK)
WORKDIR /workspace/agent-runtime
RUN npm install

# Copy agent source code
COPY src /workspace/agent-runtime/src
COPY .claude /workspace/agent-runtime/.claude

# Copy HTTP server
COPY server.js /workspace/server.js

# Verify installations
RUN node --version && npm --version

# Set working directory
WORKDIR /workspace

# Expose port for HTTP server
EXPOSE 8080

# Start the HTTP server
CMD ["node", "/workspace/server.js"]
