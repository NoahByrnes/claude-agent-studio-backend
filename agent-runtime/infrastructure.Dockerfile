# Infrastructure Worker Template
# Special E2B template for workers that can modify the worker template repository
# Includes: GitHub CLI, E2B CLI, Docker CLI, Git

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies
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

# Install Claude Code CLI globally (v1.1.0+)
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright system dependencies (for browser automation)
RUN npx playwright install-deps chromium || true

# INFRASTRUCTURE WORKER ADDITIONS:

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install E2B CLI
RUN npm install -g @e2b/cli

# Install Docker CLI (for Dockerfile analysis/modification)
RUN apt-get update && apt-get install -y docker.io && \
    rm -rf /var/lib/apt/lists/*

# Git configuration for commits
RUN git config --global user.name "Claude Agent Studio Bot" && \
    git config --global user.email "bot@claude-agent-studio.dev"

# Create workspace directory
RUN mkdir -p /workspace

# Verify installations
RUN node --version && npm --version && claude --version && gh --version && e2b --version

# Set working directory
WORKDIR /workspace

# Default command
CMD ["bash"]
