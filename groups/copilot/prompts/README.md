# Investigation Prompt Templates

This directory holds **alert-type investigation templates** used by the CoPilot SOC agent. Each file describes how to investigate a specific kind of alert (e.g. a Sysmon Process Creation event, a Windows Defender detection, a Velociraptor artifact result).

Templates are **modular**: drop a new `.txt` file in here and the agent picks it up automatically on the next investigation — no code changes, no redeploy.

---

## How the agent selects a template

Template selection happens in **Step 2.5** of the investigation workflow (see [../CLAUDE.md](../CLAUDE.md)). Selection is fully dynamic — there is no hardcoded map of alert types to filenames.

```
                                 ┌──────────────────────────┐
  Raw OpenSearch event   ───────▶│  1. List prompt files    │
  (rule_description,             │     ls /workspace/group/ │
   rule_groups,                  │        prompts/          │
   data_win_system_eventID,      └────────────┬─────────────┘
   agent_name)                                │
                                              ▼
                                 ┌──────────────────────────┐
                                 │  2. Ollama picks best    │
                                 │     filename (or NULL)   │
                                 └────────────┬─────────────┘
                                              │  NULL / unavailable
                                              ▼
                                 ┌──────────────────────────┐
                                 │  3. Fallback: match      │
                                 │     rule_groups          │
                                 │     sysmon_event_<id>    │
                                 │     keywords in          │
                                 │     rule_description     │
                                 └────────────┬─────────────┘
                                              │  no match
                                              ▼
                                 ┌──────────────────────────┐
                                 │  4. Default generic      │
                                 │     Steps 3–6 in         │
                                 │     CLAUDE.md            │
                                 └──────────────────────────┘
```

### Step 1 — Discovery

The agent runs `ls /workspace/group/prompts/` inside the container. Every `.txt` file in this directory becomes a candidate. No registration file, no index — the filesystem is the registry.

### Step 2 — Ollama-ranked selection (preferred)

If a local Ollama model is available, the agent passes the candidate filenames plus a summary of the alert (rule description, rule groups, event ID, agent) to the model and asks for the best match — or `NULL` if nothing fits. The system prompt instructs Ollama to be conservative.

### Step 3 — Filename pattern fallback

If Ollama is unavailable or returns `NULL`, the agent matches against:

| Alert signal | Matches filename |
|---|---|
| `rule_groups` value (e.g. `windows_defender`) | `windows_defender.txt` |
| `data_win_system_eventID` (e.g. `1`) | `sysmon_event_1.txt` |
| Keyword in `rule_description` | any filename containing that keyword |

### Step 4 — Default path

If nothing matches, the agent falls through to the generic investigation steps in [../CLAUDE.md](../CLAUDE.md) (IOC extraction → threat intel → correlation → report).

---

## How data is injected into the prompt

Templates use **Jinja-style placeholders**. Once a template is selected, the agent substitutes these values before following the template's instructions.

| Placeholder | Substituted with |
|---|---|
| `{{ alert }}` | Full raw OpenSearch event JSON |
| `{{ event_id }}` | Numeric event ID (e.g. `1`, `3`, `11`) |
| `{{ pipeline \| default('wazuh') }}` | `wazuh` (pipeline the alert came through) |
| `{{ virustotal_results }}` | VirusTotal enrichment output (filled in after Steps 3–4 of the workflow) |

> **Field naming note.** Graylog flattens all nested OpenSearch fields with underscores. Inside a template, reference fields as `data_win_eventdata_commandLine`, `rule_groups`, `data_win_system_eventID` — never dot notation.

### Frontmatter

Each template starts with YAML frontmatter. Frontmatter is informational — it documents the template but does not drive selection.

```yaml
---
description: Investigation template for Sysmon Event 1 (Process Creation) alerts from {{ pipeline | default('wazuh') }}.
author: Your Name
---
```

---

## Template anatomy

A template has three conceptual sections. See [sysmon_event_1.txt](sysmon_event_1.txt) for a complete example.

```
---
description: ...
author: ...
---

<role + context block>     ← who the agent is, what the alert type means

# Steps
1. ...                      ← ordered investigation instructions
2. ...                      ← may reference specific event fields
...                         ← may call for WebFetch/VT/MITRE lookups

# INPUT
```json
{{ alert }}                 ← raw event injected here
```

# Virustotal Analyses      ← optional, included when VT is relevant
```json
{% if virustotal_results %}{{ virustotal_results }}{% else %}No Virustotal analysis available.{% endif %}
```
```

### What makes a good template

- **Be specific to the alert type.** Reference the exact fields that matter (`data_win_eventdata_parentImage`, `data_win_eventdata_hashes`, etc.). Generic guidance already lives in [../CLAUDE.md](../CLAUDE.md).
- **Order steps from cheap to expensive.** Inspect the event first, extract IOCs next, then reach for external threat intel.
- **Call out the "why".** Explain what an unusual value means (e.g. "a `parentImage` of `winword.exe` spawning `powershell.exe` is a classic macro-driven execution chain").
- **Recommend follow-up actions.** If Velociraptor artifacts, Wazuh rule lookups, or SCA checks would sharpen the verdict, name them.
- **Keep it focused.** One alert class per file. If the template would branch heavily based on subtype, split it.

---

## Adding a new template

1. **Pick a filename** that matches how the alert surfaces in the SIEM:
   - Sysmon events: `sysmon_event_<id>.txt` (matches `data_win_system_eventID`)
   - Wazuh rule groups: `<group_name>.txt` (matches a value in `rule_groups`, e.g. `windows_defender.txt`)
   - Tool-specific outputs: `<tool>_<artifact>.txt` (e.g. `windows_autoruns.txt`)
   - Keep it lowercase with underscores — the pattern matcher is case-sensitive.

2. **Copy an existing template as a starting point.** [sysmon_event_1.txt](sysmon_event_1.txt) is the most complete example; [windows_defender.txt](windows_defender.txt) is a simpler one.

3. **Fill in the sections:**
   - Update the frontmatter `description` and `author`.
   - Write a 1–2 paragraph context block explaining what this alert type means.
   - List `# Steps` tailored to the alert — reference the specific fields you want the agent to inspect.
   - Keep the `# INPUT` block with `{{ alert }}` so the raw event is injected.
   - Add `# Virustotal Analyses` if IOC enrichment is relevant.

4. **Recommend Velociraptor artifacts (optional but encouraged).** If a particular artifact would confirm or rule out the threat, add a step like:

   ```
   N. **Live Forensics — Velociraptor**:
      If suspicion is high, collect these artifacts on the affected host:
      - `Windows.Sysinternals.Autoruns` — persistence mechanisms
      - `Windows.System.Pslist` — running process tree at collection time
      Use mcp__velociraptor__CollectArtifactTool with the client_id
      resolved via GetAgentInfo(hostname=<asset_name>).
   ```

5. **Test the selection.** With the container running, trigger an investigation on an alert that should match your new template. Verify:
   - Ollama (or the fallback) picks the new filename.
   - The template's steps execute end-to-end.
   - `{{ alert }}` and other placeholders substitute correctly.

6. **Open a PR.** Follow [CONTRIBUTING.md](../../../CONTRIBUTING.md) in the repo root. Include an example alert excerpt in the PR description so reviewers can sanity-check the template against a real event.

---

## Current templates

| File | Alert type |
|---|---|
| [sysmon_event_1.txt](sysmon_event_1.txt) | Process creation |
| [sysmon_event_2.txt](sysmon_event_2.txt) | File creation time changed |
| [sysmon_event_3.txt](sysmon_event_3.txt) | Network connection |
| [sysmon_event_6.txt](sysmon_event_6.txt) | Driver loaded |
| [sysmon_event_7.txt](sysmon_event_7.txt) | Image loaded |
| [sysmon_event_10.txt](sysmon_event_10.txt) | Process accessed |
| [sysmon_event_11.txt](sysmon_event_11.txt) | File created |
| [sysmon_event_12.txt](sysmon_event_12.txt) | Registry object add/delete |
| [sysmon_event_13.txt](sysmon_event_13.txt) | Registry value set |
| [sysmon_event_14.txt](sysmon_event_14.txt) | Registry key/value renamed |
| [sysmon_event_15.txt](sysmon_event_15.txt) | FileCreateStreamHash |
| [sysmon_event_16.txt](sysmon_event_16.txt) | Sysmon config state change |
| [sysmon_event_17.txt](sysmon_event_17.txt) | Pipe created |
| [sysmon_event_18.txt](sysmon_event_18.txt) | Pipe connected |
| [sysmon_event_22.txt](sysmon_event_22.txt) | DNS query |
| [windows_autoruns.txt](windows_autoruns.txt) | Windows autoruns inventory |
| [windows_defender.txt](windows_defender.txt) | Microsoft Defender detection |
| [windows_sigcheck.txt](windows_sigcheck.txt) | Sysinternals sigcheck output |

---

## Troubleshooting

**My template isn't being picked.**
- Confirm it's in `/workspace/group/prompts/` inside the container (mounted from `groups/copilot/prompts/` on the host).
- Check the filename matches something in the alert (`rule_groups`, `data_win_system_eventID`, or a keyword in `rule_description`).
- If Ollama is selecting and returns `NULL` consistently, the description in frontmatter may be too vague — make it more specific.
- Check the investigation log in `groups/copilot/logs/` for the filename Ollama returned.

**Placeholders appear literally in output.**
- The agent substitutes variables before following the template. If you see raw `{{ alert }}` in a report, the substitution step was skipped — usually because the agent read the template but didn't treat it as a template. Make sure the placeholders match the exact spelling in the table above.

**Template runs but misses fields.**
- Double-check field names use Graylog underscore flattening (`data_win_eventdata_image`, not `data.win.eventdata.image`).
