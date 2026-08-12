# MailBot

A Google Apps Script bot that monitors Gmail, analyzes emails via LLM (Anthropic Claude), and sends summaries to Google Chat.

## Features

- **Multi-job support**: Configure multiple jobs with different schedules, labels, and prompts
- **Pluggable LLM providers**: Supports Anthropic Claude (default), Google Gemini, and Ollama
- **Pluggable notifiers**: Google Chat webhooks and Signal (custom wrapper endpoint)
- **Per-job compression**: `none` / `medium` / `high` body trimming to match the model (big-context vs. small self-hosted)
- **Per-job batch size**: Cap emails per run (e.g. 1) for predictable runs on small models
- **Per-job webhook override**: Route a job to your own async service instead of the configured LLM
- **Flexible scheduling**: Run jobs at intervals or specific times
- **Conditional notifications**: Only notify when the LLM flags something as important
- **Sidebar control panel**: Manage jobs, test notifications, and control the scheduler from a sidebar UI
- **Execution logging**: Track all job runs in a Google Sheet
- **Retry logic**: Automatic retries with exponential backoff for transient API errors

## Setup

### Prerequisites

- Node.js installed
- Google account with Gmail and Google Sheets access
- Google Chat webhook URL (for notifications)
- Anthropic API key (from https://console.anthropic.com/settings/keys)

### 1. Install clasp

```bash
npm install -g @google/clasp
clasp login
```

### 2. Enable Apps Script API

Go to https://script.google.com/home/usersettings and enable the Google Apps Script API.

### 3. Create a MailBot folder in Google Drive (optional)

1. Go to [Google Drive](https://drive.google.com)
2. Create a new folder named `MailBot`
3. Open the folder and copy the folder ID from the URL:
   `https://drive.google.com/drive/folders/[FOLDER_ID]`

### 4. Run the installer

```bash
./install.sh
```

The installer will:
- Prompt for the Google Drive folder ID (optional)
- Create the Apps Script project
- Push all the code
- Open the Apps Script editor

### 5. Create the config Sheet

In the Apps Script editor that opens:

1. Select `createConfigSheet` from the function dropdown (in Config.gs)
2. Click **Run**
3. Authorize when prompted
4. Check **View → Logs** for the Sheet URL

### 6. Configure your settings

Open the Google Sheet and fill in the Settings tab:

| Key | Value | Description |
|-----|-------|-------------|
| ANTHROPIC_API_KEY | your-key | Get from https://console.anthropic.com/settings/keys |
| ANTHROPIC_MODEL | claude-sonnet-4-20250514 | Model to use |
| GEMINI_API_KEY | your-key | Get from https://aistudio.google.com/app/apikey |
| OLLAMA_URL | https://host | Ollama endpoint base URL (`/api/generate` appended automatically) |
| OLLAMA_API_KEY | your-key | Value sent in the auth header (blank if endpoint needs no auth) |
| OLLAMA_AUTH_HEADER | X-Api-Key | Name of the auth header carrying the key (deployment specific) |
| OLLAMA_MODEL | qwen3:8b | Ollama model to use |
| OLLAMA_NUM_CTX | 12288 | Context window; larger fits more emails but uses more endpoint memory |
| GOOGLE_CHAT_WEBHOOK_URL | webhook-url | Create in Google Chat space settings |
| WEBHOOK_API_KEY | your-key | Auth key sent when a job uses a WebhookURL override (can equal your Ollama key) |
| WEBHOOK_AUTH_HEADER | X-Api-Key | Header name carrying WEBHOOK_API_KEY (deployment specific) |
| SIGNAL_URL | https://host | Signal wrapper endpoint base URL (`/send` appended automatically) |
| SIGNAL_API_KEY | your-key | Value sent in the auth header (blank if endpoint needs no auth) |
| SIGNAL_AUTH_HEADER | X-Api-Key | Name of the auth header carrying the key (deployment specific) |
| SIGNAL_RECIPIENT | +15551234567 | Recipient phone number(s), comma-separated |
| LLM_PROVIDER | anthropic | `anthropic`, `gemini`, or `ollama` |
| NOTIFIER | googlechat | `googlechat` or `signal` |

### 7. Set up Gmail filters

Create Gmail filters to apply labels to incoming emails:

1. In Gmail, go to **Settings → Filters and Blocked Addresses**
2. Create a filter for emails you want processed
3. Apply label (e.g., `MailBot/Urgent`)

Example filters:
- Apply `MailBot/Urgent` to `category:primary`
- Apply `MailBot/Summary` to all incoming mail

### 8. Start the bot

Open the Google Sheet and use the sidebar:

1. Click **📧 MailBot → Open Control Panel**
2. Click **Validate Configuration** to check setup
3. Click **Create Gmail Labels** if needed
4. Click **Start Scheduler** to begin processing

## Using the Control Panel

The sidebar control panel (📧 MailBot → Open Control Panel) provides:

- **Run Selected Job** - Run a specific job manually
- **Run All Jobs Now** - Run all enabled jobs
- **Send Test Notification** - Verify notifications work
- **Validate Configuration** - Check for missing settings or labels
- **Create Gmail Labels** - Create labels defined in Jobs tab
- **Health Check** - Check system status
- **Start/Stop Scheduler** - Control the 5-minute trigger

## Installer Commands

```bash
./install.sh              # Interactive mode
./install.sh --init       # Create new Apps Script project
./install.sh --push       # Push code updates
./install.sh --open       # Open in browser
./install.sh --status     # Show configuration
./install.sh --setup-sheet # Open editor to create config sheet
./install.sh --delete     # Delete local configuration
./install.sh --help       # Show help
```

## Project Structure

```
mailbot/
├── src/
│   ├── Main.gs                # Entry point, trigger handlers
│   ├── Config.gs              # Settings, jobs, and setup functions
│   ├── JobRunner.gs           # Job execution logic, scheduling
│   ├── GmailService.gs        # Gmail operations (fetch, label, compression)
│   ├── WebhookProcessor.gs    # Per-job webhook override (fire-and-forget)
│   ├── DevExport.gs           # Dev utility: export recent inbox to Drive as JSON
│   ├── Logger.gs              # Execution logging to sheet
│   ├── SidebarController.gs   # Server-side sidebar functions
│   ├── Sidebar.html           # Sidebar UI
│   ├── llm/
│   │   ├── LLMProvider.gs     # LLM factory and base
│   │   ├── AnthropicProvider.gs # Anthropic Claude integration
│   │   ├── GeminiProvider.gs  # Google Gemini integration
│   │   └── OllamaProvider.gs  # Ollama integration (custom X-Api-Key auth)
│   └── notifier/
│       ├── Notifier.gs        # Notifier factory and base
│       ├── GoogleChatNotifier.gs # Google Chat webhook
│       └── SignalNotifier.gs  # Signal wrapper (custom X-Api-Key auth)
├── appsscript.json            # Apps Script manifest
├── install.sh                 # Installation script
├── .clasp.json                # Clasp config (generated)
├── .mailbot.conf              # Local config (generated)
└── README.md
```

## How It Works

1. **Trigger fires** every 5 minutes → `runJobs()`
2. **Load configuration** from Google Sheets
3. **For each enabled job** that should run based on its schedule:
   - Query Gmail for emails with the job's label
   - Skip if no emails found
   - Batch emails and send to LLM with job's prompt
   - Based on `NotifyCondition`:
     - `always`: Send summary to Google Chat
     - `conditional`: Only send if LLM flags as important
   - Remove label from processed emails
   - Update job status and log execution

## Job Configuration

Jobs are configured in the Jobs tab:

| Column | Description |
|--------|-------------|
| JobName | Unique identifier |
| Enabled | TRUE/FALSE checkbox |
| Label | Gmail label to monitor (e.g., `MailBot/Urgent`) |
| Prompt | LLM prompt for analyzing emails |
| ScheduleType | `interval` or `specific_times` |
| ScheduleValue | Minutes for interval, or comma-separated times (e.g., `08:00,18:00`) |
| NotifyCondition | `always` or `conditional` (only notify if flagged important) |
| AutoLabel | TRUE/FALSE — let the LLM apply Gmail labels per email |
| AutoStar | TRUE/FALSE — let the LLM star important emails |
| Compression | `none` / `medium` / `high` (blank = medium) — how much to trim bodies before sending. See below |
| BatchSize | Max emails processed per run. Blank/`0` = no limit; `>0` caps the batch (rest picked up next run) |
| WebhookURL | Optional. If set, POST the batch here instead of the configured LLM (see below) |

The `LastRun*` columns are written by the bot; leave them blank.

### Compression levels

Output size is a strict ladder: **`none` ≥ `medium` ≥ `high`** (a higher level never produces a larger payload than a lower one). Blank defaults to `medium`.

| Aspect | `none` | `medium` | `high` |
|---|---|---|---|
| HTML tags / comments / entities stripped | ❌ | ✅ | ✅ |
| Whitespace collapsed | ❌ | ✅ | ✅ |
| Quoted replies + signatures stripped | ❌ | ❌ kept | ✅ stripped |
| URLs collapsed to `[link]` | ❌ | ⚠️ long only (> 100 chars) | ✅ all |
| Per-email char cap | none (raw) | fixed 2,000 | `min(2000, 24000 ÷ emailCount)`, floor 300 |
| Total prompt bound | none | grows with count (2k × N) | bounded to ~24k across the batch |
| Relative output size | largest | middle | smallest |
| Best for | big-context models (Anthropic 1M) | per-email / map-reduce webhook | small/self-hosted models, large batches |

Per-email cap by batch size:

| emails in batch | `medium` cap | `high` cap |
|---|---|---|
| 1 | 2,000 | 2,000 |
| 12 | 2,000 | 2,000 |
| 20 | 2,000 | 1,200 |
| 50 | 2,000 | 480 |
| 100+ | 2,000 | 300 (floor) |

Mental model:
- **`medium`** = *clean but faithful* — cleans HTML/whitespace, keeps quotes and short URLs (collapses long tracking URLs > 100 chars), caps each email at 2k; total scales with the number of emails.
- **`high`** = *medium plus aggressive slimming* — also strips quoted replies/signatures and collapses **all** URLs, and hard-bounds the whole batch to ~24k. Always ≤ `medium`.

The tunable constants (`MAX_BODY_LENGTH`, `LLM_CHAR_BUDGET`, `MIN_BODY_CHARS`) live at the top of `src/GmailService.gs`.

### BatchSize

Set `BatchSize = 1` for the every-5-minute urgent job on a small model to keep each
run predictable (one email at a time). Only the processed batch has its label
removed, so a backlog drains one run at a time.

### WebhookURL (per-job override)

If a job has a `WebhookURL`, MailBot POSTs the batch to it **instead of** calling
the configured LLM. It's fire-and-forget: MailBot sends structured, compression-aware
JSON (`{ job, emails[] }`), expects a fast **2xx ack**, and lets the webhook do the
processing (and its own notification) asynchronously.

- On `2xx`: the processing label is removed. If the response body contains an
  analysis (`{ summary, isImportant, emails }`), MailBot uses it (notify/label/star);
  otherwise MailBot does nothing further.
- On failure: the label is kept (retried next run) and an error notification is sent.
- Transient failures (5xx/429/network) are retried with backoff.
- Auth: `WEBHOOK_API_KEY` sent in `WEBHOOK_AUTH_HEADER` (default `X-Api-Key`).

Tip: pair with `Compression = none` to ship full bodies to a lab service that does
its own compression / map-reduce.

## Label Strategy

- Gmail rules apply labels to incoming emails
- Script queries for emails with labels
- After processing, script removes labels
- Result: clean inbox with no "processed" labels cluttering things

## Adding New Providers

### New LLM Provider

1. Create `src/llm/YourProvider.gs`
2. Create a factory function that returns `{ analyze: function(prompt, content) }`
3. Register in `LLMFactory.create()` in LLMProvider.gs

### New Notifier

1. Create `src/notifier/YourNotifier.gs`
2. Create a factory function that returns `{ send: function(title, message), sendError: function(title, error) }`
3. Register in `NotifierFactory.create()` in Notifier.gs

## Troubleshooting

### Config not loading
- Run **Health Check** from the sidebar
- Verify CONFIG_SHEET_ID is set in Script Properties (File → Project Properties)
- Check sheet has Settings, Jobs, and ExecutionLog tabs

### Emails not being processed
- Check Gmail labels exist (use **Create Gmail Labels** button)
- Verify Gmail filters are applying labels to incoming mail
- Check the Jobs tab - is the job enabled?

### No notifications
- Use **Send Test Notification** from the sidebar
- Verify GOOGLE_CHAT_WEBHOOK_URL is correct
- Check ExecutionLog tab for errors

### LLM errors
- Verify ANTHROPIC_API_KEY is valid
- Check ExecutionLog for specific error messages
- API will retry automatically on transient errors (5xx, 429)

### Scheduler not running
- Use **Health Check** to see if trigger is active
- Click **Start Scheduler** to create the trigger
- Check Apps Script dashboard for execution errors
