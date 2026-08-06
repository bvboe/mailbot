# MailBot

A Google Apps Script bot that monitors Gmail, analyzes emails via LLM (Anthropic Claude), and sends summaries to Google Chat.

## Features

- **Multi-job support**: Configure multiple jobs with different schedules, labels, and prompts
- **Pluggable LLM providers**: Supports Anthropic Claude (default), Google Gemini, and Ollama
- **Pluggable notifiers**: Google Chat webhooks
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
| GOOGLE_CHAT_WEBHOOK_URL | webhook-url | Create in Google Chat space settings |
| LLM_PROVIDER | anthropic | `anthropic`, `gemini`, or `ollama` |
| NOTIFIER | googlechat | Notification service |

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
│   ├── GmailService.gs        # Gmail operations (fetch, label)
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
│       └── GoogleChatNotifier.gs # Google Chat webhook
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
| NotifyCondition | `always` or `conditional` |

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
