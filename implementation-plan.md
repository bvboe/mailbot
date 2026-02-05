# Gmail Bot - Architecture & Deployment Plan

## Overview
A Google Apps Script bot that monitors Gmail, analyzes emails via LLM, and sends summaries via IM. Built with pluggable integrations starting with Google Gemini and Google Chat.

## Architecture

### Google Apps Script Project Structure
```
mailbot/
├── src/
│   ├── Main.gs              # Entry point, trigger handlers
│   ├── Config.gs            # Load settings & jobs from Google Sheets
│   ├── JobRunner.gs         # Job execution logic, scheduling checks
│   ├── GmailService.gs      # Gmail operations (fetch, label)
│   ├── llm/
│   │   ├── LLMProvider.gs   # Interface/base for LLM providers
│   │   └── GeminiProvider.gs # Google Gemini implementation
│   ├── notifier/
│   │   ├── Notifier.gs      # Interface/base for notifiers
│   │   └── GoogleChatNotifier.gs # Google Chat webhook
│   └── Logger.gs            # Execution logging to sheet
├── appsscript.json          # Apps Script manifest
├── .clasp.json              # Clasp config (after init)
└── README.md
```

### Example Job Configurations

| JobName | Enabled | Label | Prompt | ScheduleType | ScheduleValue | NotifyCondition | LastRun | LastRunStatus | LastRunEmailCount | LastRunError |
|---------|---------|-------|--------|--------------|---------------|-----------------|---------|---------------|-------------------|--------------|
| urgent | TRUE | MailBot/Urgent | "Analyze and flag if important..." | interval | 5 | conditional | 2024-01-15 10:30 | success | 3 | |
| summary | TRUE | MailBot/Summary | "Summarize all emails..." | specific_times | 08:00,12:00,16:00 | always | 2024-01-15 08:00 | success | 12 | |

### Label Strategy (Simple)
1. **Gmail rules** (set up by user) apply job-specific labels to incoming emails:
   - Rule: "Apply label `MailBot/Urgent` to incoming emails matching category:primary"
   - Rule: "Apply label `MailBot/Summary` to all incoming emails"
2. **Script** queries for emails WITH the job's label
3. **After processing**, script REMOVES the label from processed emails
4. **Result**: Clean inbox, no "processed" labels cluttering things up
5. **No read/unread changes** - script only manages labels

### Google Sheets Structure
Single spreadsheet with tabs:

1. **Settings** - Global key-value pairs:
   - `GEMINI_API_KEY` - API key for Gemini
   - `GOOGLE_CHAT_WEBHOOK_URL` - Webhook URL for notifications
   - `LLM_PROVIDER` - Which LLM to use (default: "gemini")
   - `NOTIFIER` - Which notifier to use (default: "googlechat")

2. **Jobs** - One row per job, columns:
   - `JobName` - Unique identifier (e.g., "urgent", "summary")
   - `Enabled` - TRUE/FALSE
   - `Label` - Gmail label for this job (applied by Gmail rule, removed after processing)
   - `Prompt` - LLM prompt specific to this job
   - `ScheduleType` - "interval" or "specific_times"
   - `ScheduleValue` - Minutes for interval OR comma-separated times (e.g., "08:00,12:00,16:00")
   - `NotifyCondition` - "always" or "conditional" (for urgent: only notify if LLM says important)
   - `LastRun` - Timestamp of last execution
   - `LastRunStatus` - "success" or "error"
   - `LastRunEmailCount` - Number of emails processed in last run
   - `LastRunError` - Error message if last run failed

3. **ExecutionLog** - Columns:
   - Timestamp | JobName | Status | Emails Processed | Summary | Error (if any)

### Flow
1. Time trigger fires → `Main.runJobs()`
2. Load global settings and jobs from Sheets
3. For each enabled job that should run now (based on schedule):
   a. Query Gmail for emails WITH the job's label
   b. If no emails found, skip (update LastRun, count=0)
   c. Batch all emails together:
      - Extract subject, sender, body preview for each
      - Send entire batch to LLM with job's prompt
   d. Based on `NotifyCondition`:
      - "always": Send summary to IM
      - "conditional": Only send if LLM indicates something important
   e. REMOVE the job's label from all processed emails
   f. Update job's LastRun, LastRunStatus, LastRunEmailCount in Jobs sheet
   g. Log execution to ExecutionLog
4. Master trigger runs every 5 min; each job checks its own schedule

### Error Handling
- Wrap main execution in try/catch
- On error: Log to ExecutionLog sheet AND send error notification via IM
- Continue processing remaining emails if one fails to parse

### Pluggable Design
- **LLM Providers**: Factory pattern - `LLMFactory.create(providerName)` returns provider instance
- **Notifiers**: Factory pattern - `NotifierFactory.create(notifierName)` returns notifier instance
- Adding new providers = new file + register in factory

## Deployment Strategy

### Phase 1: Project Setup
1. Install `clasp` CLI globally: `npm install -g @google/clasp`
2. Login to Google: `clasp login`
3. Create new Apps Script project: `clasp create --type standalone --title "MailBot"`
4. This generates `.clasp.json` with script ID

### Phase 2: Google Sheets Setup
1. Create Google Sheet manually (or via script)
2. Set up Config and ExecutionLog tabs
3. Store Sheet ID in `appsscript.json` or hardcode initially

### Phase 3: Deploy & Configure
1. Push code: `clasp push`
2. Open in browser: `clasp open`
3. Set up time-based trigger via Apps Script UI:
   - Edit → Current project's triggers → Add trigger
   - Choose `checkEmails` function, time-driven, every X minutes/hours
4. Configure OAuth scopes in `appsscript.json`

### Required OAuth Scopes
```json
{
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

## Implementation Order (Architecture First)
1. **Setup**: Create project structure, `appsscript.json`, clasp config
2. **Config**: Implement `Config.gs` to read from sheets
3. **Logger**: Implement `Logger.gs` for execution logging
4. **Stubs**: Create stub implementations for Gmail, LLM, Notifier
5. **Deploy & Test**: Push to Apps Script, verify config loading works
6. **Fill In**: Implement real Gmail, Gemini, Google Chat integrations

## Verification
1. `clasp push` succeeds without errors
2. `clasp open` → Run `testConfig()` function manually → Verify config loads
3. Check ExecutionLog tab for test log entry
4. Set up trigger, wait for execution, verify log entry appears

## Decisions Made
- **Multi-job architecture**: Support multiple jobs with different schedules and prompts
- **Simple label strategy**: Gmail rules apply labels to incoming; script removes after processing
- **No "processed" labels**: Cleaner inbox - labels only exist while email is pending
- **No read/unread changes**: Script only manages labels, never marks emails as read
- **Summary includes all**: Both jobs can have the same emails (separate labels via Gmail rules)
- **Jobs table config**: Jobs defined as rows with execution tracking columns
- **Batching**: Combine all emails into one LLM call → one notification per job run
- **Error handling**: Log errors to sheet AND send error notification via IM
- **Email body**: Truncate to reasonable length (e.g., 2000 chars) to stay within LLM context limits
- **Single master trigger**: One trigger runs every 5 min; jobs self-check their schedule
