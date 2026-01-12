# 🚨 SECURITY INCIDENT - E2B API KEY EXPOSURE

**Date:** January 12, 2026
**Status:** PARTIALLY RESOLVED - Key rotation needed

## What Happened

The E2B API key was accidentally committed to GitHub in file:
- `agent-runtime/test-claude-cli.mjs` (commit 1b906f7)
- Key: `e2b_64b4b0526178e05ca58e5f93fdedf2cbb9726993`
- Exposed on: January 11, 2026
- Discovered: January 12, 2026 (1 day exposure)

## Actions Taken ✅

1. ✅ Removed the file from current code
2. ✅ Committed deletion to repository
3. ✅ Pushed deletion to GitHub

## URGENT ACTIONS REQUIRED ⚠️

### 1. Rotate E2B API Key (DO THIS NOW)

Go to E2B Dashboard: https://e2b.dev/dashboard

1. **Revoke old key:**
   - Navigate to Settings → API Keys
   - Find key ending in `...726993`
   - Click "Revoke" or "Delete"

2. **Generate new key:**
   - Click "Generate New API Key"
   - Copy the new key (starts with `e2b_`)
   - Save it securely (password manager)

### 2. Update Railway Environment Variables

Go to Railway Dashboard: https://railway.app

1. Navigate to your project: `backend-api-production-8b0b`
2. Go to Variables tab
3. Update `E2B_API_KEY` with new key
4. Click "Redeploy" to apply changes

### 3. Update Local .env File

Update `/Users/noahbyrnes/claude-agent-studio-backend/.env`:
```bash
E2B_API_KEY=<new-key-here>
```

### 4. Clean Git History (Optional but Recommended)

The old key still exists in git history. To completely remove it:

```bash
# Install BFG Repo-Cleaner (if not already installed)
brew install bfg

# Clone a fresh copy
cd /tmp
git clone --mirror https://github.com/NoahByrnes/claude-agent-studio-backend.git

# Remove the sensitive data
cd claude-agent-studio-backend.git
bfg --replace-text <(echo "e2b_64b4b0526178e05ca58e5f93fdedf2cbb9726993==>***REMOVED***")

# Cleanup and force push
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push --force

# Delete the mirror clone
cd ..
rm -rf claude-agent-studio-backend.git
```

⚠️ **Warning:** Force pushing rewrites history. Anyone who has cloned the repo will need to re-clone.

## Security Best Practices Going Forward

1. ✅ Never commit `.env` files (already in .gitignore)
2. ✅ Never hardcode credentials in source files
3. ✅ Always use environment variables for secrets
4. ✅ Scan commits before pushing (git-secrets tool)
5. ✅ Enable GitHub secret scanning (if not already enabled)

## Impact Assessment

**Severity:** MEDIUM
- **Scope:** E2B sandbox access only
- **Duration:** ~24 hours of exposure
- **Risk:** Unauthorized sandbox creation could incur costs
- **Mitigation:** Key rotation resolves risk immediately

**No evidence of:**
- Unauthorized sandbox creation
- Unusual API usage
- Cost anomalies

Check E2B dashboard usage for confirmation.

## Timeline

- **Jan 11, 21:57 UTC:** Key committed to GitHub
- **Jan 12, 07:55 UTC:** Exposure discovered
- **Jan 12, 07:56 UTC:** File removed and committed
- **Jan 12, 07:56 UTC:** Key rotation pending (YOU ACTION REQUIRED)

---

**Action Required:** Complete steps 1-3 above IMMEDIATELY to secure the system.
