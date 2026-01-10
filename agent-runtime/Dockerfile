FROM docker.io/cloudflare/sandbox:0.4.11
# Alternative for E2B: FROM e2b/sandbox

# Install Node.js 20 and build tools
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    jq \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

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

# Expose port for HTTP server
EXPOSE 8080

# Start the HTTP server
# This is required for Cloudflare Containers - the container will not be considered
# "ready" until a service is listening on port 8080
CMD ["node", "/workspace/server.js"]
