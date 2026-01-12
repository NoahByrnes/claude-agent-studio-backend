# Memory Persistence with claude-mem

The conductor uses the [claude-mem](https://github.com/thedotmack/claude-mem) plugin to maintain context across sessions.

## How It Works

1. **claude-mem Plugin**: Installed in the E2B template during sandbox creation
2. **Automatic Capture**: The plugin captures tool observations and generates semantic summaries
3. **Persistent Storage**: Memory is stored in `~/.claude-mem/` (SQLite + Chroma vector DB)
4. **Session Continuity**: Memory is exported/imported between conductor restarts

## Memory Lifecycle

```
Conductor Init
  ↓
1. Create E2B Sandbox
  ↓
2. Import Memory (if backup exists)
  ↓
3. Start Claude CLI Session with memory available
  ↓
[Conversations happen]
  ↓
4. Export Memory after each conversation
  ↓
[Conductor continues or restarts]
  ↓
5. On restart: goto step 1
```

## Storage Location

**Local Backups**: `/tmp/conductor-memory-backups/conductor.tar.gz`

- Stored on Railway container filesystem
- Persists across conductor restarts within same deployment
- Resets on Railway redeploys (acceptable for MVP)

## Future Enhancements

### Option 1: Railway Volume

Mount a persistent volume in Railway:
```yaml
# railway.toml
[volumes]
conductor-memory = "/app/conductor-memory"
```

Then update `BACKUP_DIR` in memory.service.ts:
```typescript
const BACKUP_DIR = '/app/conductor-memory';
```

### Option 2: External Storage (S3/Supabase)

Replace file-based storage with cloud storage:

```typescript
// In memory.service.ts
import { S3 } from '@aws-sdk/client-s3';

export async function exportMemoryToS3(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  // 1. Export memory from sandbox
  const memoryData = await sandbox.files.read('/tmp/claude-mem.tar.gz');

  // 2. Upload to S3
  await s3.putObject({
    Bucket: 'conductor-memory',
    Key: `${conductorId}.tar.gz`,
    Body: memoryData,
  });
}
```

### Option 3: Database Storage

Store memory summaries directly in Supabase:

```typescript
// Extract summaries from SQLite and store in Supabase
export async function syncMemoryToDatabase(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  // Read SQLite, extract summaries, store in Supabase
}
```

## Memory Content

claude-mem automatically captures:

- **Tool Observations**: Results from file reads, commands, searches
- **Semantic Summaries**: AI-generated summaries of observations
- **Session Context**: What was learned/discovered
- **Project Knowledge**: Files, structure, patterns

## Privacy

To exclude sensitive information:

```
<private>
This content won't be captured in memory
API keys, passwords, etc.
</private>
```

## Monitoring

Check memory backup status:

```bash
ls -lh /tmp/conductor-memory-backups/
```

View memory contents (in E2B sandbox):

```bash
cd /root/.claude-mem
sqlite3 memory.db ".tables"
```

## Configuration

claude-mem settings auto-created in `~/.claude-mem/settings.json`:

```json
{
  "model": "claude-sonnet-4.5",
  "workerPort": 37777,
  "dataDir": "~/.claude-mem",
  "logLevel": "info"
}
```

## Cost Implications

- **Token Usage**: claude-mem uses Claude API to generate summaries
- **Storage**: SQLite DB grows over time (~1-10MB typical)
- **Optimization**: 3-layer search reduces tokens by ~10x

## Troubleshooting

### Memory Not Persisting

1. Check backup directory exists: `ls /tmp/conductor-memory-backups/`
2. Check Railway logs for export/import errors
3. Verify E2B template has claude-mem installed

### Memory Too Large

1. Clear old memories: `rm /tmp/conductor-memory-backups/conductor.tar.gz`
2. Or, add size limits in memory.service.ts

### Workers Not Seeing Conductor Memory

This is expected! Workers are independent Claude instances with their own sessions. Only the conductor maintains persistent memory. Workers communicate results back to the conductor, which stores them in its memory.

## Benefits

- **Context Retention**: Conductor remembers project details across sessions
- **Reduced Repetition**: No need to re-explain project structure
- **Better Decisions**: Access to historical context when orchestrating workers
- **Conversation Continuity**: "Remember when we discussed X?" works across sessions

---

**Note**: Memory persistence is automatic. No additional configuration needed beyond E2B template installation.
