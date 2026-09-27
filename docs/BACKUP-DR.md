# BACKUP & DISASTER RECOVERY (DR) RUNBOOK — DOGFOOD 2026

## 1. Executive Summary & Recovery Objectives
The **DOGFOOD 2026** platform operates an offline-first, embedded SQLite 3 engine configured with write-ahead logging (`journal_mode = WAL`), explicit timeouts (`busy_timeout = 10000`), and synchronous normal durability (`synchronous = NORMAL`). 

### Core Recovery Targets
| Objective | Metric | Mechanism |
| :--- | :--- | :--- |
| **RPO (Recovery Point Objective)** | < 1 second | Append-only WAL transaction journaling with synchronous commits |
| **RTO (Recovery Time Objective)** | < 2 seconds | Direct filesystem mount restoration & instant SQLite process attach |
| **Availability During Backup** | 100% Zero-Downtime | SQLite `VACUUM INTO` online atomic hot snapshots |

---

## 2. Online Hot Backup API
Event coordinators and platform administrators can trigger an online, lockless hot database snapshot at any time without stopping the Fastify server or interrupting active judging evaluations.

### Triggering a Snapshot via API
```bash
curl -X POST http://localhost:8080/api/organizer/backup \
  -H "Cookie: session=org_7f2a"
```

### Response
```json
{
  "ok": true,
  "message": "Hot SQLite database snapshot created successfully",
  "filename": "dogfood-backup-2026-09-27T17-20-00-000Z.sqlite",
  "sizeBytes": 204800,
  "createdAt": "2026-09-27T17:20:00.000Z"
}
```

### Mechanism: SQLite `VACUUM INTO`
Unlike naive file copying (which risks capturing a corrupt split-page write if executed concurrently with WAL commits), `VACUUM INTO` establishes an internal read lock, repacks pages, merges committed WAL transactions, and outputs an atomic, defragmented single-file snapshot directly to `backups/`.

---

## 3. Disaster Recovery & Restoration Procedures

### Scenario A: Accidental Data Corruption or Degraded State
1. **Locate the Latest Verified Snapshot:**
   ```bash
   ls -la backups/dogfood-backup-*.sqlite | sort | tail -n 1
   ```
2. **Perform Offline Integrity Check on Backup:**
   ```bash
   sqlite3 backups/dogfood-backup-<timestamp>.sqlite "PRAGMA integrity_check;"
   # Expected output: ok
   ```
3. **Restore the Primary Database:**
   ```bash
   # Stop application container
   docker compose stop web
   
   # Archive damaged database
   mv data/dogfood.sqlite data/dogfood-corrupt-$(date +%s).sqlite
   rm -f data/dogfood.sqlite-wal data/dogfood.sqlite-shm
   
   # Restore clean snapshot
   cp backups/dogfood-backup-<timestamp>.sqlite data/dogfood.sqlite
   
   # Restart application container
   docker compose up -d web
   ```

### Scenario B: WAL Checkpoint Truncation & Compaction
If the WAL log grows excessively during heavy judging throughput:
```bash
sqlite3 data/dogfood.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
```
This flushes all uncommitted WAL pages back into the primary database file and truncates the WAL file to zero bytes.

---

## 4. Verification and Cold Recovery Drill
To test automated restoration and verification:
```bash
# 1. Execute online hot snapshot
curl -s -X POST http://localhost:8080/api/organizer/backup -H "Cookie: session=org_7f2a"

# 2. Verify snapshot page health
sqlite3 backups/$(ls -t backups | head -n 1) "SELECT count(*) FROM projects; SELECT count(*) FROM scores;"
# Must report 41 projects and >= 126 reviews
```
