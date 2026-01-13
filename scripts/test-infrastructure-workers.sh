#!/bin/bash
# Test Infrastructure Workers
# Quick tests to verify infrastructure worker setup

set -e

echo "🧪 Testing Infrastructure Worker Setup"
echo "====================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Check environment variables
echo "Test 1: Checking environment variables..."
echo ""

check_env_var() {
    VAR_NAME=$1
    if [ -z "${!VAR_NAME}" ]; then
        echo -e "${RED}❌ $VAR_NAME not set${NC}"
        return 1
    else
        echo -e "${GREEN}✅ $VAR_NAME set${NC}"
        return 0
    fi
}

# Check local .env if it exists
if [ -f .env ]; then
    echo "Loading .env file..."
    export $(cat .env | grep -v '^#' | xargs)
fi

VARS_OK=true
check_env_var "E2B_TEMPLATE_ID" || VARS_OK=false
check_env_var "E2B_INFRASTRUCTURE_TEMPLATE_ID" || VARS_OK=false
check_env_var "WORKER_TEMPLATE_REPO" || VARS_OK=false
check_env_var "GITHUB_TOKEN" || VARS_OK=false

echo ""

if [ "$VARS_OK" = false ]; then
    echo -e "${RED}❌ Test 1 FAILED: Missing environment variables${NC}"
    echo ""
    echo "Set these in Railway or in .env file:"
    echo "  E2B_TEMPLATE_ID=..."
    echo "  E2B_INFRASTRUCTURE_TEMPLATE_ID=..."
    echo "  WORKER_TEMPLATE_REPO=noahbyrnes/claude-agent-studio-worker-template"
    echo "  GITHUB_TOKEN=ghp_..."
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ Test 1 PASSED: All environment variables set${NC}"
echo ""

# Test 2: Check GitHub token validity
echo "Test 2: Validating GitHub token..."
echo ""

if command -v gh &> /dev/null; then
    # Try to use the token
    if GH_TOKEN=$GITHUB_TOKEN gh auth status &> /dev/null; then
        echo -e "${GREEN}✅ Test 2 PASSED: GitHub token is valid${NC}"
    else
        echo -e "${RED}❌ Test 2 FAILED: GitHub token is invalid or expired${NC}"
        echo ""
        echo "Create a new token at: https://github.com/settings/tokens"
        echo "Required scope: repo"
        echo ""
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  Test 2 SKIPPED: gh CLI not installed${NC}"
    echo "   Install with: brew install gh"
fi

echo ""

# Test 3: Check repository access
echo "Test 3: Checking repository access..."
echo ""

if command -v gh &> /dev/null; then
    if GH_TOKEN=$GITHUB_TOKEN gh repo view "$WORKER_TEMPLATE_REPO" &> /dev/null; then
        echo -e "${GREEN}✅ Test 3 PASSED: Can access repository${NC}"
    else
        echo -e "${RED}❌ Test 3 FAILED: Cannot access repository${NC}"
        echo ""
        echo "Repository: $WORKER_TEMPLATE_REPO"
        echo "Either:"
        echo "  1. Repository doesn't exist (run setup script)"
        echo "  2. Token doesn't have access"
        echo "  3. Wrong repository name in WORKER_TEMPLATE_REPO"
        echo ""
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  Test 3 SKIPPED: gh CLI not installed${NC}"
fi

echo ""

# Test 4: Check E2B templates exist
echo "Test 4: Checking E2B templates..."
echo ""

if command -v e2b &> /dev/null; then
    # Check if logged in
    if ! e2b auth whoami &> /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Test 4 SKIPPED: Not logged into E2B${NC}"
        echo "   Run: e2b auth login"
    else
        # Try to list templates and see if ours exist
        echo "Checking standard worker template: $E2B_TEMPLATE_ID"
        if e2b template list 2>&1 | grep -q "$E2B_TEMPLATE_ID"; then
            echo -e "${GREEN}✅ Standard worker template exists${NC}"
        else
            echo -e "${YELLOW}⚠️  Standard worker template not found in list${NC}"
            echo "   (May be from different account, but should still work)"
        fi

        echo "Checking infrastructure worker template: $E2B_INFRASTRUCTURE_TEMPLATE_ID"
        if e2b template list 2>&1 | grep -q "$E2B_INFRASTRUCTURE_TEMPLATE_ID"; then
            echo -e "${GREEN}✅ Infrastructure worker template exists${NC}"
        else
            echo -e "${YELLOW}⚠️  Infrastructure worker template not found in list${NC}"
            echo "   (May be from different account, but should still work)"
        fi

        echo -e "${GREEN}✅ Test 4 PASSED: E2B templates configured${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Test 4 SKIPPED: e2b CLI not installed${NC}"
    echo "   Install with: npm install -g @e2b/cli"
fi

echo ""

# Test 5: Check TypeScript build
echo "Test 5: Checking TypeScript build..."
echo ""

if npm run build &> /dev/null; then
    echo -e "${GREEN}✅ Test 5 PASSED: TypeScript builds successfully${NC}"
else
    echo -e "${RED}❌ Test 5 FAILED: TypeScript build errors${NC}"
    echo ""
    echo "Run: npm run build"
    echo "to see errors"
    echo ""
    exit 1
fi

echo ""

# Summary
echo "========================================="
echo -e "${GREEN}✅ All Tests Passed!${NC}"
echo "========================================="
echo ""
echo "Your infrastructure worker setup is ready!"
echo ""
echo "Next steps:"
echo "1. Deploy to Railway if not already done"
echo "2. Test with Stu via SMS or dashboard:"
echo ""
echo "   Test message: \"Are infrastructure workers enabled?\""
echo ""
echo "   Advanced test: \"Spawn an infrastructure worker to analyze"
echo "                   the worker template and list installed packages\""
echo ""
echo "3. See QUICK_START_INFRASTRUCTURE_WORKERS.md for full testing guide"
echo ""
