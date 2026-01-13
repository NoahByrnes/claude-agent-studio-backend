#!/bin/bash
# Setup Worker Template Repository
# This script creates the worker template repository and builds E2B templates

set -e  # Exit on error

REPO_NAME="claude-agent-studio-worker-template"
REPO_OWNER="noahbyrnes"
REPO_FULL="${REPO_OWNER}/${REPO_NAME}"

echo "🚀 Setting up Worker Template Repository"
echo "========================================="
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) not found. Please install it:"
    echo "   brew install gh"
    echo "   or visit: https://cli.github.com/"
    exit 1
fi

# Check if e2b CLI is installed
if ! command -v e2b &> /dev/null; then
    echo "❌ E2B CLI not found. Installing..."
    npm install -g @e2b/cli
fi

# Check authentication
echo "📋 Checking GitHub authentication..."
if ! gh auth status &> /dev/null; then
    echo "❌ Not authenticated with GitHub. Running gh auth login..."
    gh auth login
fi

echo "✅ GitHub authenticated"
echo ""

# Check E2B authentication
echo "📋 Checking E2B authentication..."
if ! e2b auth whoami &> /dev/null 2>&1; then
    echo "❌ Not authenticated with E2B. Running e2b auth login..."
    e2b auth login
fi

echo "✅ E2B authenticated"
echo ""

# Create repository
echo "📦 Creating GitHub repository: ${REPO_FULL}..."
if gh repo view "${REPO_FULL}" &> /dev/null; then
    echo "⚠️  Repository already exists: ${REPO_FULL}"
    read -p "   Delete and recreate? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "   Deleting existing repository..."
        gh repo delete "${REPO_FULL}" --yes
    else
        echo "   Using existing repository..."
    fi
fi

if ! gh repo view "${REPO_FULL}" &> /dev/null; then
    gh repo create "${REPO_FULL}" \
        --public \
        --description "E2B template for Claude Agent Studio workers" \
        --clone=false
    echo "✅ Repository created: https://github.com/${REPO_FULL}"
else
    echo "✅ Using existing repository: https://github.com/${REPO_FULL}"
fi

echo ""

# Create temporary directory for repo setup
TEMP_DIR=$(mktemp -d)
cd "${TEMP_DIR}"

echo "📝 Setting up repository files..."

# Clone the repo
gh repo clone "${REPO_FULL}"
cd "${REPO_NAME}"

# Copy Dockerfile from backend
echo "   Copying Dockerfile..."
cp "${OLDPWD}/../agent-runtime/Dockerfile" ./Dockerfile

# Copy infrastructure Dockerfile
echo "   Copying infrastructure Dockerfile..."
cp "${OLDPWD}/../agent-runtime/infrastructure.Dockerfile" ./infrastructure.Dockerfile

# Create .e2b.toml
echo "   Creating .e2b.toml..."
cat > .e2b.toml << 'EOF'
[template]
name = "claude-agent-studio-worker"
runtime = "ubuntu:22.04"
EOF

# Create README.md
echo "   Creating README.md..."
cat > README.md << 'EOF'
# Claude Agent Studio Worker Template

E2B template for Claude Agent Studio workers. This repository contains the container definitions that workers run in.

## Templates

### Standard Worker Template (`Dockerfile`)
Used by regular workers for general task execution.

**Includes:**
- Node.js 20
- Claude Code CLI
- Playwright system dependencies
- Python 3
- Basic utilities (curl, wget, git, jq)

### Infrastructure Worker Template (`infrastructure.Dockerfile`)
Used by infrastructure workers that can modify this repository.

**Additional capabilities:**
- GitHub CLI (gh) - Create PRs, manage issues
- E2B CLI - Rebuild templates
- Docker CLI - Analyze and modify Dockerfiles
- Git configuration for commits

## Building Templates

### Standard Worker Template
```bash
e2b template build
```

### Infrastructure Worker Template
```bash
e2b template build -f infrastructure.Dockerfile --name claude-agent-studio-worker-infra
```

## Usage

Workers are automatically spawned by Stu (the conductor) using these templates. Template IDs are configured via environment variables:

- `E2B_TEMPLATE_ID` - Standard worker template
- `E2B_INFRASTRUCTURE_TEMPLATE_ID` - Infrastructure worker template

## Self-Modification

Infrastructure workers can modify this repository to add new capabilities:

1. Worker clones this repo
2. Worker edits Dockerfile to add packages/tools
3. Worker creates PR with changes
4. Stu reviews PR for security
5. Stu approves, worker merges
6. Worker rebuilds E2B template
7. New capabilities available to all future workers

## Contributing

This repository is automatically maintained by Claude Agent Studio infrastructure workers. Manual changes should be reviewed carefully to ensure they don't break the self-modification system.

## License

MIT
EOF

# Create .gitignore
echo "   Creating .gitignore..."
cat > .gitignore << 'EOF'
node_modules/
.env
.env.local
*.log
.DS_Store
EOF

# Commit and push
echo "   Committing files..."
git add .
git commit -m "Initial worker template

- Standard worker Dockerfile with Node.js, Claude CLI, Playwright deps
- Infrastructure worker Dockerfile with GitHub CLI, E2B CLI, Docker
- E2B configuration
- Documentation

This repository contains E2B templates for Claude Agent Studio workers.
Infrastructure workers can modify this repo to add capabilities autonomously."

echo "   Pushing to GitHub..."
git push origin main

echo "✅ Repository files pushed to GitHub"
echo ""

# Build standard worker template
echo "🔨 Building standard worker template..."
WORKER_TEMPLATE_ID=$(e2b template build --name claude-agent-studio-worker 2>&1 | grep -o 'Template ID: [a-z0-9]*' | cut -d' ' -f3)

if [ -z "$WORKER_TEMPLATE_ID" ]; then
    echo "❌ Failed to get worker template ID"
    echo "   Try running manually: cd ${TEMP_DIR}/${REPO_NAME} && e2b template build"
    exit 1
fi

echo "✅ Standard worker template built: ${WORKER_TEMPLATE_ID}"
echo ""

# Build infrastructure worker template
echo "🔨 Building infrastructure worker template..."
INFRA_TEMPLATE_ID=$(e2b template build -f infrastructure.Dockerfile --name claude-agent-studio-worker-infra 2>&1 | grep -o 'Template ID: [a-z0-9]*' | cut -d' ' -f3)

if [ -z "$INFRA_TEMPLATE_ID" ]; then
    echo "❌ Failed to get infrastructure template ID"
    echo "   Try running manually: cd ${TEMP_DIR}/${REPO_NAME} && e2b template build -f infrastructure.Dockerfile"
    exit 1
fi

echo "✅ Infrastructure worker template built: ${INFRA_TEMPLATE_ID}"
echo ""

# Create GitHub token instructions
echo "🔑 GitHub Token Setup"
echo "===================="
echo ""
echo "Create a Personal Access Token for infrastructure workers:"
echo "1. Go to: https://github.com/settings/tokens"
echo "2. Click 'Generate new token (classic)'"
echo "3. Select scopes: [x] repo (full control of private repositories)"
echo "4. Click 'Generate token'"
echo "5. Copy the token (starts with ghp_)"
echo ""

# Summary
echo "✅ Setup Complete!"
echo "=================="
echo ""
echo "Repository: https://github.com/${REPO_FULL}"
echo ""
echo "Template IDs:"
echo "  Standard Worker:       ${WORKER_TEMPLATE_ID}"
echo "  Infrastructure Worker: ${INFRA_TEMPLATE_ID}"
echo ""
echo "Next Steps:"
echo "1. Create GitHub Personal Access Token (see instructions above)"
echo "2. Set environment variables in Railway:"
echo ""
echo "   E2B_TEMPLATE_ID=${WORKER_TEMPLATE_ID}"
echo "   E2B_INFRASTRUCTURE_TEMPLATE_ID=${INFRA_TEMPLATE_ID}"
echo "   WORKER_TEMPLATE_REPO=${REPO_FULL}"
echo "   WORKER_TEMPLATE_BRANCH=main"
echo "   GITHUB_TOKEN=ghp_your_token_here"
echo ""
echo "3. Deploy to Railway (will auto-deploy on git push)"
echo ""
echo "Repository location: ${TEMP_DIR}/${REPO_NAME}"
echo "Keep this directory to make future changes or delete it when done."
echo ""
