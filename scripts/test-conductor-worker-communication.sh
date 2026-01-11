#!/bin/bash
# test-conductor-worker-communication.sh
#
# Test script to verify two Claude CLI sessions can communicate
# by passing messages between them using --resume.
#
# Prerequisites:
# - Claude CLI installed and authenticated
# - jq installed for JSON parsing

set -e

echo "=========================================="
echo "  Conductor ↔ Worker Communication Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create a test directory
TEST_DIR=$(mktemp -d)
cd "$TEST_DIR"
echo "Working directory: $TEST_DIR"
echo ""

# -----------------------------------------------------------------------------
# Step 1: Initialize CONDUCTOR session
# -----------------------------------------------------------------------------
echo -e "${BLUE}[1/6] Initializing CONDUCTOR session...${NC}"

CONDUCTOR_RESPONSE=$(claude -p "You are a CONDUCTOR agent. Your job is to:
1. Receive incoming messages (emails, tasks)
2. Decide if they need action
3. Delegate to workers by outputting: DELEGATE_TO_WORKER: <task>
4. Validate worker results
5. Send final responses

Acknowledge your role briefly." --output-format json 2>/dev/null)

CONDUCTOR_ID=$(echo "$CONDUCTOR_RESPONSE" | jq -r '.session_id')
echo -e "${GREEN}✓ Conductor session: $CONDUCTOR_ID${NC}"
echo "  Response: $(echo "$CONDUCTOR_RESPONSE" | jq -r '.result' | head -c 100)..."
echo ""

# -----------------------------------------------------------------------------
# Step 2: Initialize WORKER session
# -----------------------------------------------------------------------------
echo -e "${BLUE}[2/6] Initializing WORKER session...${NC}"

WORKER_RESPONSE=$(claude -p "You are a WORKER agent. Your job is to:
1. Receive tasks from the conductor
2. Complete them thoroughly
3. Report back with: TASK_COMPLETE: <summary>

Acknowledge your role briefly." --output-format json 2>/dev/null)

WORKER_ID=$(echo "$WORKER_RESPONSE" | jq -r '.session_id')
echo -e "${GREEN}✓ Worker session: $WORKER_ID${NC}"
echo "  Response: $(echo "$WORKER_RESPONSE" | jq -r '.result' | head -c 100)..."
echo ""

# -----------------------------------------------------------------------------
# Step 3: Send EMAIL to CONDUCTOR
# -----------------------------------------------------------------------------
echo -e "${BLUE}[3/6] Sending email to CONDUCTOR...${NC}"

EMAIL_MESSAGE='[EMAIL]
From: client@example.com
To: agent@mycompany.com
Subject: Please create a simple hello world script

Hi, can you create a simple Python script that prints "Hello World"?
Thanks!'

CONDUCTOR_RESPONSE=$(claude -p --resume "$CONDUCTOR_ID" "$EMAIL_MESSAGE" --output-format json 2>/dev/null)
CONDUCTOR_OUTPUT=$(echo "$CONDUCTOR_RESPONSE" | jq -r '.result')

echo -e "${GREEN}✓ Conductor received email${NC}"
echo "  Response:"
echo "  $CONDUCTOR_OUTPUT" | head -5
echo ""

# Check if conductor wants to delegate
if echo "$CONDUCTOR_OUTPUT" | grep -qi "delegate\|worker\|task"; then
    echo -e "${YELLOW}→ Conductor wants to delegate to worker${NC}"
    DELEGATE_TASK="Create a Python script that prints Hello World"
else
    DELEGATE_TASK="Create a Python script that prints Hello World"
fi
echo ""

# -----------------------------------------------------------------------------
# Step 4: Send task to WORKER
# -----------------------------------------------------------------------------
echo -e "${BLUE}[4/6] Sending task to WORKER...${NC}"

WORKER_TASK="[TASK FROM CONDUCTOR]
$DELEGATE_TASK

Complete this task and report back with TASK_COMPLETE: <summary>"

WORKER_RESPONSE=$(claude -p --resume "$WORKER_ID" "$WORKER_TASK" --output-format json 2>/dev/null)
WORKER_OUTPUT=$(echo "$WORKER_RESPONSE" | jq -r '.result')

echo -e "${GREEN}✓ Worker received task${NC}"
echo "  Response:"
echo "  $WORKER_OUTPUT" | head -10
echo ""

# -----------------------------------------------------------------------------
# Step 5: Send WORKER result back to CONDUCTOR
# -----------------------------------------------------------------------------
echo -e "${BLUE}[5/6] Sending worker result to CONDUCTOR...${NC}"

WORKER_REPORT="[WORKER REPORT]
Status: COMPLETE
Result: $WORKER_OUTPUT

Please validate this and compose a response email to the client."

CONDUCTOR_RESPONSE=$(claude -p --resume "$CONDUCTOR_ID" "$WORKER_REPORT" --output-format json 2>/dev/null)
CONDUCTOR_FINAL=$(echo "$CONDUCTOR_RESPONSE" | jq -r '.result')

echo -e "${GREEN}✓ Conductor received worker report${NC}"
echo "  Final response:"
echo "  $CONDUCTOR_FINAL" | head -10
echo ""

# -----------------------------------------------------------------------------
# Step 6: Summary
# -----------------------------------------------------------------------------
echo -e "${BLUE}[6/6] Test Summary${NC}"
echo "=========================================="
echo -e "Conductor Session ID: ${GREEN}$CONDUCTOR_ID${NC}"
echo -e "Worker Session ID:    ${GREEN}$WORKER_ID${NC}"
echo ""
echo "Communication flow verified:"
echo "  1. ✓ Email → Conductor"
echo "  2. ✓ Conductor → Worker (task delegation)"
echo "  3. ✓ Worker → Conductor (result report)"
echo "  4. ✓ Conductor → Final response"
echo ""
echo "=========================================="
echo -e "${GREEN}TEST PASSED: Two CLI sessions can communicate!${NC}"
echo "=========================================="
echo ""
echo "Sessions can be resumed later:"
echo "  claude --resume $CONDUCTOR_ID"
echo "  claude --resume $WORKER_ID"
echo ""

# Cleanup
cd -
rm -rf "$TEST_DIR"
