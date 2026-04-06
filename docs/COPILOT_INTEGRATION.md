# NanoClaw × CoPilot Integration

> **Status:** In progress — MCP write-back tools under development in CoPilot.

This document describes the architecture for integrating the NanoClaw AI analyst with the SOCfortress CoPilot application. The goal is a seamless analyst experience: alerts are automatically investigated by the AI, findings are written back into CoPilot, and analysts can interact with the AI directly from within the platform.

---

## Design Principles

- **CoPilot is the database of record.** All investigation results, job status, and extracted IOCs are stored in CoPilot's MySQL database — not in NanoClaw's SQLite store.
- **NanoClaw is the AI brain.** It detects alert types, loads the right analysis template, queries the SIEM, runs threat intel, and produces structured reports.
- **The agent never writes directly to MySQL.** The MySQL MCP tool is read-only. Agent write-back goes through a CoPilot REST API, which validates and persists results. This keeps the database boundary clean and auditable.
- **Both trigger paths produce identical output.** Whether an investigation is started by a real-time `POST /investigate` call or the 15-minute scheduled task, the agent runs the same workflow and writes back through the same API.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   CoPilot (FastAPI)                  │
│                                                     │
│  Alert created ──► POST /investigate ──────────────┐│
│                                                    ││
│  GET /nanoclaw/status   ◄──── NanoClaw HTTP API    ││
│  GET /nanoclaw/jobs/:id ◄──── NanoClaw HTTP API    ││
│                                                    ││
│  MCP write-back tools:                             ││
│    POST /api/v1/ai-analyst/jobs       ◄────────────┘│
│    POST /api/v1/ai-analyst/reports                  │
│    POST /api/v1/ai-analyst/iocs                     │
│                                                     │
│  MySQL ──────────────────────────────────────────── │
│    ai_analyst_job                                   │
│    ai_analyst_report                                │
│    ai_analyst_ioc                                   │
└─────────────────────────────────────────────────────┘
          │  read-only MCP              ▲ REST write-back
          ▼                             │
┌─────────────────────────────────────────────────────┐
│                  NanoClaw (Node.js)                  │
│                                                     │
│  HTTP channel (port 3100)                           │
│    POST /investigate   ← CoPilot triggers this      │
│    POST /message       ← ad-hoc analyst prompts     │
│    GET  /status        ← queue + job overview       │
│    GET  /jobs/:alertId ← per-alert report status    │
│    GET  /health                                     │
│                                                     │
│  Scheduled task (every 15 min)                      │
│    Queries MySQL for OPEN alerts with no job row    │
│    Runs full investigation per alert                │
│                                                     │
│  Copilot container agent                            │
│    groups/copilot/CLAUDE.md   ← investigation flow  │
│    groups/copilot/prompts/    ← per-alert templates  │
└─────────────────────────────────────────────────────┘
```

---

## Trigger Paths

### Path 1 — Real-time: `POST /investigate`

CoPilot calls this endpoint immediately when an alert is created (or when an analyst clicks "Analyze with AI" on the alert detail page).

**Request:**
```json
POST http://nanoclaw:3100/investigate
{
  "alert_id": 1234,
  "customer_code": "acme",
  "sender": "copilot"
}
```

**NanoClaw behaviour:**
1. Creates a job row in `ai_analyst_job` (status = `pending`) via the CoPilot write-back API
2. Enqueues the investigation into the copilot group container
3. Returns `{ "job_id": "..." }` immediately (investigation runs async)

### Path 2 — Scheduled: 15-minute task

The scheduled task runs every 15 minutes and picks up any OPEN alert that does not yet have a job row — acting as a safety net for anything the real-time path missed.

```sql
SELECT a.id, a.alert_name, a.source, a.alert_creation_time,
       a.customer_code, ast.asset_name, ast.agent_id,
       ast.index_name, ast.index_id
FROM incident_management_alert a
JOIN incident_management_asset ast ON ast.alert_linked = a.id
LEFT JOIN ai_analyst_job j ON j.alert_id = a.id
WHERE a.status = 'OPEN'
  AND ast.index_name != ''
  AND ast.index_id != ''
  AND j.id IS NULL           -- not yet investigated
ORDER BY a.alert_creation_time DESC;
```

Both paths feed the same investigation workflow and write back through the same CoPilot API.

---

## Investigation Workflow (Agent-Side)

The copilot agent follows these steps for every alert, defined in `groups/copilot/CLAUDE.md`:

1. **Pull alert from MySQL** — `incident_management_alert` + `incident_management_asset`
2. **Fetch raw SIEM event + index mapping** — `get_document` and `get_index` in parallel. The mapping confirms exact field names and types before any search query is built.
3. **Detect alert type + load template** — checks `rule.groups` for `sysmon_event_<N>`, falls back to `data.win.system.eventID`. Reads `/workspace/group/prompts/<type>.txt` if a template exists.
4. **Extract IOCs** — IPs, domains, hashes, processes, commands
5. **Threat intel** — VirusTotal (hashes + IPs + domains), Shodan, AbuseIPDB, MITRE ATT&CK
6. **SIEM correlation** — lateral movement, persistence, other affected hosts
7. **Write results back to CoPilot** — via MCP write-back tools (see below)
8. **Send report to analyst** — via `send_message` to the webhook/HTTP channel

---

## Alert-Type Prompt Templates

Templates live in `groups/copilot/prompts/` and are mounted into the agent container at `/workspace/group/prompts/`. Each file is a plain-text investigation guide with template variables.

| File | Alert Type | Sysmon Event |
|------|-----------|--------------|
| `sysmon_event_1.txt` | Process Creation | Event ID 1 |
| `sysmon_event_3.txt` *(planned)* | Network Connection | Event ID 3 |
| `sysmon_event_7.txt` *(planned)* | Image Load / DLL | Event ID 7 |
| `sysmon_event_11.txt` *(planned)* | File Create | Event ID 11 |
| `sysmon_event_22.txt` *(planned)* | DNS Query | Event ID 22 |

**Template variables** the agent substitutes at runtime:

| Variable | Value |
|----------|-------|
| `{{ alert }}` | Full raw OpenSearch event JSON |
| `{{ event_id }}` | Numeric Sysmon event ID (e.g. `1`) |
| `{{ pipeline \| default('wazuh') }}` | Log pipeline name |
| `{{ virustotal_results }}` | VT findings after threat intel step |

To add a new alert type, create the corresponding `.txt` file — no code changes required.

---

## CoPilot MySQL Schema

Three new tables store all AI analyst state:

```sql
-- One row per investigation job
CREATE TABLE ai_analyst_job (
  id            VARCHAR(64) PRIMARY KEY,
  alert_id      INT NOT NULL,
  customer_code VARCHAR(64) NOT NULL,
  status        ENUM('pending','running','completed','failed') DEFAULT 'pending',
  alert_type    VARCHAR(64),
  triggered_by  ENUM('scheduled','manual','webhook') NOT NULL,
  template_used VARCHAR(128),
  created_at    DATETIME NOT NULL,
  started_at    DATETIME,
  completed_at  DATETIME,
  error_message TEXT
);

-- Full investigation report per alert
CREATE TABLE ai_analyst_report (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  job_id              VARCHAR(64) NOT NULL,
  alert_id            INT NOT NULL,
  customer_code       VARCHAR(64) NOT NULL,
  severity_assessment ENUM('Critical','High','Medium','Low','Informational'),
  report_markdown     MEDIUMTEXT,
  summary             TEXT,
  recommended_actions TEXT,
  created_at          DATETIME NOT NULL
);

-- IOCs extracted and enriched during investigation
CREATE TABLE ai_analyst_ioc (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  report_id     INT NOT NULL,
  alert_id      INT NOT NULL,
  customer_code VARCHAR(64) NOT NULL,
  ioc_value     VARCHAR(512) NOT NULL,
  ioc_type      ENUM('ip','domain','hash','process','url','user','command'),
  vt_verdict    ENUM('malicious','suspicious','clean','unknown') DEFAULT 'unknown',
  vt_score      VARCHAR(32),
  details       TEXT,
  created_at    DATETIME NOT NULL
);
```

---

## Agent Write-Back (CoPilot MCP Tools)

The agent has **read-only** access to MySQL. All writes go through CoPilot REST API endpoints exposed as MCP tools in the agent's environment. CoPilot validates the payload and persists results.

> **Status:** MCP tools under development in CoPilot. NanoClaw-side integration pending.

### Planned MCP Tools

| Tool | Method + Path | Purpose |
|------|--------------|---------|
| `create_analyst_job` | `POST /api/v1/ai-analyst/jobs` | Register a new job when investigation starts |
| `update_analyst_job` | `PATCH /api/v1/ai-analyst/jobs/{id}` | Update status (running → completed/failed) |
| `submit_analyst_report` | `POST /api/v1/ai-analyst/reports` | Write the full investigation report |
| `submit_analyst_iocs` | `POST /api/v1/ai-analyst/iocs` | Write extracted + enriched IOCs |

### Example: `submit_analyst_report` payload

```json
{
  "job_id": "copilot-inv-1234-abc",
  "alert_id": 1234,
  "customer_code": "acme",
  "severity_assessment": "High",
  "summary": "Suspicious PowerShell spawned by Word — likely phishing dropper.",
  "report_markdown": "## Alert Summary\n...",
  "recommended_actions": "Isolate host. Block hash on EDR. Escalate to IR."
}
```

---

## NanoClaw HTTP API

Endpoints on the HTTP channel (default port `3100`) that CoPilot can call or display:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness check |
| `GET /status` | Queue depth, active containers, last N completed jobs |
| `GET /jobs/:alertId` | Job status and report link for a specific alert |
| `POST /investigate` | Trigger a deep investigation for `{ alert_id, customer_code }` |
| `POST /message` | Ad-hoc prompt from an analyst — routes to the copilot agent |

> **Status:** `/investigate`, `/status`, and `/jobs/:alertId` are planned. `/message` and `/health` exist today.

---

## CoPilot UI Integration (Planned)

Once the write-back API and NanoClaw endpoints are in place, CoPilot can surface:

- **Alert detail page** — "AI Analysis" tab: severity badge, summary, full report, IOC table
- **Alert list** — status column: `⚡ Analyzed` / `⏳ Analyzing` / `✗ Failed` / `—`
- **Dashboard widget** — NanoClaw queue: N running, N completed today, N failed
- **IOC browser** — filter by `vt_verdict = 'malicious'` across all AI-discovered IOCs
- **"Analyze with AI" button** — calls `POST /investigate`, shows a spinner, auto-refreshes

---

## Implementation Roadmap

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Alert-type prompt templates (`sysmon_event_1.txt`) | NanoClaw | ✅ Done |
| 2 | Investigation workflow + index mapping step (CLAUDE.md) | NanoClaw | ✅ Done |
| 3 | Upgraded scheduled task (full investigation per alert) | NanoClaw | ✅ Done |
| 4 | MySQL schema: `ai_analyst_job/report/ioc` tables | CoPilot | Planned |
| 5 | CoPilot write-back REST API endpoints | CoPilot | In progress |
| 6 | CoPilot MCP tools for agent write-back | CoPilot | In progress |
| 7 | Scheduled task deduplication (skip existing jobs) | NanoClaw | Pending MCP tools |
| 8 | `POST /investigate` endpoint in NanoClaw | NanoClaw | Pending MCP tools |
| 9 | `GET /status` + `GET /jobs/:alertId` endpoints | NanoClaw | Pending |
| 10 | Additional prompt templates (events 3, 7, 11, 22) | NanoClaw | Planned |
| 11 | CoPilot UI: alert analysis tab + status badges | CoPilot | Planned |
