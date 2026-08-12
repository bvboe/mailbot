/**
 * Config.gs - Load settings & jobs from Google Sheets
 *
 * Expected sheet structure:
 * - Settings tab: Key-value pairs (A=key, B=value)
 * - Jobs tab: Job configurations addressed by header name (see JOB_COLUMN_ORDER)
 */

// Sheet ID - UPDATE THIS after creating your Google Sheet
const CONFIG_SHEET_ID = PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID') || '';

const SETTINGS_TAB = 'Settings';
const JOBS_TAB = 'Jobs';
const EXECUTION_LOG_TAB = 'ExecutionLog';

// The Jobs tab is addressed by HEADER NAME (not fixed position), so columns can
// be reordered or new ones inserted without breaking reads/writes, and an
// absent column simply falls back to a default. This array also defines the
// default column order used when creating a fresh sheet.
const JOB_COLUMN_ORDER = [
  'JobName', 'Enabled', 'Label', 'Prompt', 'ScheduleType', 'ScheduleValue',
  'NotifyCondition', 'AutoLabel', 'AutoStar',
  'Compression', 'BatchSize', 'WebhookURL',
  'LastRun', 'LastRunStatus', 'LastRunEmailCount', 'LastRunError'
];

/**
 * Build a case-insensitive header-name -> 0-based column index map from a
 * sheet's header row.
 * @param {Array} headerRow
 * @returns {Object}
 */
function buildColumnMap_(headerRow) {
  const map = {};
  for (let i = 0; i < headerRow.length; i++) {
    const name = String(headerRow[i] || '').trim().toLowerCase();
    if (name) {
      map[name] = i;
    }
  }
  return map;
}

/**
 * Load all global settings from the Settings tab
 * @returns {Object} Key-value map of settings
 */
function loadSettings() {
  const sheet = getSheet_(SETTINGS_TAB);
  const data = sheet.getDataRange().getValues();
  const settings = {};

  // Skip header row, read key-value pairs
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    const value = data[i][1];
    if (key) {
      settings[key] = value;
    }
  }

  return settings;
}

/**
 * Load all jobs from the Jobs tab
 * @returns {Array<Object>} Array of job configurations
 */
function loadJobs() {
  const sheet = getSheet_(JOBS_TAB);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return [];
  }

  const col = buildColumnMap_(data[0]);
  // Read a cell by header name; returns '' if that column doesn't exist.
  const val = (row, header) => {
    const i = col[header.toLowerCase()];
    return i === undefined ? '' : row[i];
  };

  const jobs = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!val(row, 'JobName')) continue; // Skip empty rows

    jobs.push({
      rowIndex: i + 1, // 1-based for sheet operations
      jobName: val(row, 'JobName'),
      enabled: val(row, 'Enabled') === true || val(row, 'Enabled') === 'TRUE',
      label: val(row, 'Label'),
      prompt: val(row, 'Prompt'),
      scheduleType: val(row, 'ScheduleType'),
      scheduleValue: String(val(row, 'ScheduleValue')),
      notifyCondition: val(row, 'NotifyCondition'),
      autoLabel: val(row, 'AutoLabel') === true || val(row, 'AutoLabel') === 'TRUE',
      autoStar: val(row, 'AutoStar') === true || val(row, 'AutoStar') === 'TRUE',
      lastRun: val(row, 'LastRun'),
      lastRunStatus: val(row, 'LastRunStatus'),
      lastRunEmailCount: val(row, 'LastRunEmailCount'),
      lastRunError: val(row, 'LastRunError'),
      // Per-job compression level: 'none' | 'medium' | 'high' (default medium).
      compression: String(val(row, 'Compression') || ''),
      // Max emails to process per run: 0/blank = no limit, >0 = cap.
      batchSize: parseInt(val(row, 'BatchSize'), 10) || 0,
      // If set, POST the batch here instead of calling the configured LLM.
      webhookUrl: String(val(row, 'WebhookURL') || '').trim()
    });
  }

  return jobs;
}

/**
 * Update job execution status in the Jobs tab
 * @param {number} rowIndex - 1-based row index in the sheet
 * @param {Date} lastRun - Timestamp of execution
 * @param {string} status - "success" or "error"
 * @param {number} emailCount - Number of emails processed
 * @param {string} error - Error message (empty if success)
 */
function updateJobStatus(rowIndex, lastRun, status, emailCount, error) {
  const sheet = getSheet_(JOBS_TAB);

  // Write each status field by header name, so column order/position doesn't
  // matter and the fields need not be contiguous.
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = buildColumnMap_(header);
  const set = (name, value) => {
    const i = col[name.toLowerCase()];
    if (i !== undefined) {
      sheet.getRange(rowIndex, i + 1).setValue(value);
    }
  };

  set('LastRun', lastRun);
  set('LastRunStatus', status);
  set('LastRunEmailCount', emailCount);
  set('LastRunError', error || '');
}

/**
 * Get a sheet by name from the config spreadsheet
 * @param {string} tabName - Name of the tab
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet_(tabName) {
  if (!CONFIG_SHEET_ID) {
    throw new Error('CONFIG_SHEET_ID not set. Please set it in Script Properties.');
  }

  const spreadsheet = SpreadsheetApp.openById(CONFIG_SHEET_ID);
  const sheet = spreadsheet.getSheetByName(tabName);

  if (!sheet) {
    throw new Error(`Sheet "${tabName}" not found in spreadsheet.`);
  }

  return sheet;
}

/**
 * Test function to verify config loading works
 */
function testConfig() {
  try {
    console.log('Loading settings...');
    const settings = loadSettings();
    console.log('Settings:', JSON.stringify(settings, null, 2));

    console.log('Loading jobs...');
    const jobs = loadJobs();
    console.log('Jobs:', JSON.stringify(jobs, null, 2));

    console.log('Config test successful!');
    return { settings, jobs };
  } catch (e) {
    console.error('Config test failed:', e.message);
    throw e;
  }
}

// ============================================================================
// SETUP FUNCTIONS - Run createConfigSheet() once during initial setup
// ============================================================================

/**
 * Create the config Google Sheet with all required tabs and structure.
 * The sheet is created in the same folder as this Apps Script project.
 *
 * Run this function once during initial setup.
 * The Sheet ID will be logged - copy it to Script Properties as CONFIG_SHEET_ID.
 */
function createConfigSheet() {
  // Get the folder where this script lives
  const scriptId = ScriptApp.getScriptId();
  const scriptFile = DriveApp.getFileById(scriptId);
  const parents = scriptFile.getParents();

  let folderId = null;
  if (parents.hasNext()) {
    folderId = parents.next().getId();
  }

  // Create the spreadsheet
  const spreadsheet = SpreadsheetApp.create('MailBot Config');
  const spreadsheetId = spreadsheet.getId();

  // Move to the same folder as the script
  if (folderId) {
    const file = DriveApp.getFileById(spreadsheetId);
    const folder = DriveApp.getFolderById(folderId);
    file.moveTo(folder);
    console.log(`Moved sheet to folder: ${folder.getName()}`);
  }

  // Set up the Settings tab (rename default sheet)
  const settingsSheet = spreadsheet.getSheets()[0];
  settingsSheet.setName('Settings');
  setupSettingsTab_(settingsSheet);

  // Create Jobs tab
  const jobsSheet = spreadsheet.insertSheet('Jobs');
  setupJobsTab_(jobsSheet);

  // Create ExecutionLog tab
  const logSheet = spreadsheet.insertSheet('ExecutionLog');
  setupExecutionLogTab_(logSheet);

  // Store the sheet ID in script properties
  PropertiesService.getScriptProperties().setProperty('CONFIG_SHEET_ID', spreadsheetId);

  // Install the sidebar menu
  try {
    installSidebarMenu();
    console.log('Sidebar menu installed');
  } catch (e) {
    console.log('Note: Could not install sidebar menu automatically: ' + e.message);
    console.log('Run installSidebarMenu() manually after setup.');
  }

  // Log the results
  console.log('='.repeat(60));
  console.log('CONFIG SHEET CREATED SUCCESSFULLY!');
  console.log('='.repeat(60));
  console.log(`Sheet ID: ${spreadsheetId}`);
  console.log(`Sheet URL: ${spreadsheet.getUrl()}`);
  console.log('');
  console.log('The Sheet ID has been saved to Script Properties.');
  console.log('');
  console.log('Next steps:');
  console.log('1. Open the sheet - you should see a "📧 MailBot" menu');
  console.log('2. Click MailBot → Open Control Panel');
  console.log('3. Fill in your API keys in the Settings tab');
  console.log('4. Use the sidebar to validate config and start the scheduler');
  console.log('='.repeat(60));

  return spreadsheetId;
}

/**
 * Set up the Settings tab with default structure
 */
function setupSettingsTab_(sheet) {
  // Headers
  sheet.getRange('A1:C1').setValues([['Key', 'Value', 'Description']]);
  sheet.getRange('A1:C1').setFontWeight('bold').setBackground('#f3f3f3');

  // Default settings with descriptions
  const settings = [
    ['ANTHROPIC_API_KEY', '', 'Get your API key from https://console.anthropic.com/settings/keys'],
    ['ANTHROPIC_MODEL', 'claude-sonnet-4-20250514', 'Options: claude-3-haiku-20240307, claude-3-5-haiku-20241022, claude-sonnet-4-20250514, claude-opus-4-20250514'],
    ['GEMINI_API_KEY', '', 'Get your API key from https://aistudio.google.com/app/apikey'],
    ['OLLAMA_URL', '', 'Ollama endpoint base URL (e.g. https://your-host). /api/generate is appended automatically'],
    ['OLLAMA_API_KEY', '', 'Value sent in the auth header (leave blank if the endpoint needs no auth)'],
    ['OLLAMA_AUTH_HEADER', 'X-Api-Key', 'Name of the auth header carrying OLLAMA_API_KEY (deployment specific)'],
    ['OLLAMA_MODEL', 'qwen3:8b', 'Ollama model to use (e.g. qwen3:8b, llama3.1:8b)'],
    ['OLLAMA_NUM_CTX', '12288', 'Context window (num_ctx). Larger fits more emails but uses more endpoint memory. 12288 is a safe max for an 8B model on an 8GB Jetson'],
    ['GOOGLE_CHAT_WEBHOOK_URL', '', 'Create a webhook in Google Chat space settings'],
    ['WEBHOOK_API_KEY', '', 'Auth key sent when a job uses a WebhookURL override (can equal your Ollama key)'],
    ['WEBHOOK_AUTH_HEADER', 'X-Api-Key', 'Header name carrying WEBHOOK_API_KEY (deployment specific)'],
    ['SIGNAL_URL', '', 'Signal wrapper endpoint base URL (e.g. https://your-host). /send is appended automatically'],
    ['SIGNAL_API_KEY', '', 'Value sent in the auth header (leave blank if the endpoint needs no auth)'],
    ['SIGNAL_AUTH_HEADER', 'X-Api-Key', 'Name of the auth header carrying SIGNAL_API_KEY (deployment specific)'],
    ['SIGNAL_RECIPIENT', '', 'Recipient phone number(s), comma-separated (e.g. +15551234567)'],
    ['LLM_PROVIDER', 'anthropic', 'LLM provider to use (anthropic, gemini, or ollama)'],
    ['NOTIFIER', 'googlechat', 'Notification service (googlechat or signal)'],
    ['LOG_LEVEL', 'normal', 'Logging verbosity: normal or verbose'],
    ['LABEL_PREFIX', 'MailBot/', 'Prefix for auto-created labels (e.g., MailBot/ or empty for no prefix)']
  ];

  sheet.getRange(2, 1, settings.length, 3).setValues(settings);

  // Format
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 400);
  sheet.setColumnWidth(3, 500);

  // Make description column italic and gray
  sheet.getRange(2, 3, settings.length, 1).setFontStyle('italic').setFontColor('#5f6368');
}

/**
 * Set up the Jobs tab with default structure and example jobs
 */
function setupJobsTab_(sheet) {
  // Headers
  // Default column order for a fresh sheet. Reads/writes are by header name,
  // so users may later reorder these without breaking anything.
  const headers = JOB_COLUMN_ORDER;

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f3f3');

  // Example jobs
  const jobs = [
    [
      'urgent',
      true,
      'MailBot/Urgent',
      'Flag ONLY emails that need the recipient\'s immediate personal attention today.\n\nFlag as IMPORTANT only if the email clearly requires prompt action, e.g.:\n- A hard deadline in the next day or two\n- Security/fraud alerts that explicitly ask you to verify or report an unrecognized charge or sign-in\n- System outages, failed jobs, or critical errors\n- A bill or invoice actually due soon that is NOT on autopay\n- A time-sensitive decision, approval, or reply a real person is waiting on\n\nDo NOT flag these (they are never urgent):\n- Promotions, sales, discounts, upsells, warranty/renewal offers, or "watch/attend" blasts ("order before", "X% off", "race day", "tune in")\n- Order confirmations and shipping, tracking, or delivery updates (tracking a package is optional)\n- Optional delivery instructions ("if you\'d like, add delivery instructions")\n- Transaction receipts, approvals, payment-received notices, or "card may not have been present" alerts — UNLESS they explicitly ask you to confirm or report an unrecognized charge. Generic "report a suspicious email" footers and "contact the merchant / questions about this purchase" text are boilerplate, not actions.\n- Bills or invoices on autopay or scheduled automatic payment ("via Auto Pay")\n- Newsletters and social or FYI notifications (profile views, new listings, market updates)\n- General appeals from organizations, charities, or newsletters (donate, volunteer, "help us")\n- Successful or passing automated/CI runs (only failures are urgent)\n\nIf anything is urgent, briefly explain what and why. If nothing requires immediate action, respond with: "No urgent items found."',
      'interval',
      '5',
      'conditional',
      true,   // AutoLabel
      true,   // AutoStar
      'medium', // Compression
      '', // BatchSize (blank = no limit; set to 1 for predictable urgent runs)
      '', // WebhookURL (blank = use the configured LLM)
      '', '', '', '' // LastRun, LastRunStatus, LastRunEmailCount, LastRunError
    ],
    [
      'daily-summary',
      true,
      'MailBot/Summary',
      'Provide a brief summary of these emails grouped by category or sender. Include:\n- Key information and updates\n- Action items mentioned\n- Upcoming deadlines or events\n\nKeep it concise. If there are few or no emails, just say "Light inbox - nothing notable."',
      'specific_times',
      '08:00,18:00',
      'always',
      false,  // AutoLabel
      false,  // AutoStar
      'high', // Compression
      '', // BatchSize (blank = no limit)
      '', // WebhookURL (blank = use the configured LLM)
      '', '', '', '' // LastRun, LastRunStatus, LastRunEmailCount, LastRunError
    ]
  ];

  sheet.getRange(2, 1, jobs.length, headers.length).setValues(jobs);

  // Format columns
  sheet.setColumnWidth(1, 120);  // JobName
  sheet.setColumnWidth(2, 70);   // Enabled
  sheet.setColumnWidth(3, 150);  // Label
  sheet.setColumnWidth(4, 300);  // Prompt
  sheet.setColumnWidth(5, 100);  // ScheduleType
  sheet.setColumnWidth(6, 120);  // ScheduleValue
  sheet.setColumnWidth(7, 110);  // NotifyCondition
  sheet.setColumnWidth(8, 80);   // AutoLabel
  sheet.setColumnWidth(9, 80);   // AutoStar
  sheet.setColumnWidth(10, 110); // Compression
  sheet.setColumnWidth(11, 90);  // BatchSize
  sheet.setColumnWidth(12, 260); // WebhookURL
  sheet.setColumnWidth(13, 150); // LastRun
  sheet.setColumnWidth(14, 100); // LastRunStatus
  sheet.setColumnWidth(15, 120); // LastRunEmailCount
  sheet.setColumnWidth(16, 200); // LastRunError

  // Add data validation for Enabled column
  const enabledRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();
  sheet.getRange('B2:B100').setDataValidation(enabledRule);

  // Add data validation for ScheduleType
  const scheduleTypeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['interval', 'specific_times'])
    .build();
  sheet.getRange('E2:E100').setDataValidation(scheduleTypeRule);

  // Add data validation for NotifyCondition
  const notifyConditionRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['always', 'conditional'])
    .build();
  sheet.getRange('G2:G100').setDataValidation(notifyConditionRule);

  // Add data validation for AutoLabel column
  const autoLabelRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();
  sheet.getRange('H2:H100').setDataValidation(autoLabelRule);

  // Add data validation for AutoStar column
  const autoStarRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();
  sheet.getRange('I2:I100').setDataValidation(autoStarRule);

  // Add data validation for Compression column (column J)
  const compressionRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['none', 'medium', 'high'])
    .build();
  sheet.getRange('J2:J100').setDataValidation(compressionRule);

  // Add notes
  sheet.getRange('C1').setNote('Gmail label to monitor. Create matching Gmail filter rules.');
  sheet.getRange('E1').setNote('interval = run every N minutes\nspecific_times = run at specific times');
  sheet.getRange('F1').setNote('For interval: minutes between runs\nFor specific_times: comma-separated HH:MM times');
  sheet.getRange('G1').setNote('always = always notify\nconditional = only if LLM flags as important');
  sheet.getRange('H1').setNote('Enable LLM-based auto-labeling of emails (e.g., Internal, Customers/Acme)');
  sheet.getRange('I1').setNote('Enable LLM-based starring of important emails');
  sheet.getRange('J1').setNote('Body compression before sending to the LLM. Size ladder: none >= medium >= high.\nnone = full bodies, untouched (big-context models)\nmedium = clean HTML/whitespace, keep quotes & short URLs (collapse long tracking URLs), 2000 chars/email\nhigh = medium PLUS strip quoted replies + collapse ALL URLs, tighter cap (small models)\nBlank defaults to medium.');
  sheet.getRange('K1').setNote('Max emails processed per run.\nBlank or 0 = no limit.\n>0 = cap the batch (e.g. 1 for predictable urgent runs on small models). The remainder keeps its label and is processed on the next run.');
  sheet.getRange('L1').setNote('Optional. If set, MailBot POSTs the batch to this URL instead of the configured LLM (fire-and-forget; expects a 2xx ack). Auth via WEBHOOK_API_KEY / WEBHOOK_AUTH_HEADER in Settings.');
}

/**
 * Set up the ExecutionLog tab
 */
function setupExecutionLogTab_(sheet) {
  // Headers
  const headers = ['Timestamp', 'JobName', 'Status', 'EmailsProcessed', 'Summary', 'Error'];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f3f3');

  // Format columns
  sheet.setColumnWidth(1, 180);  // Timestamp
  sheet.setColumnWidth(2, 120);  // JobName
  sheet.setColumnWidth(3, 80);   // Status
  sheet.setColumnWidth(4, 120);  // EmailsProcessed
  sheet.setColumnWidth(5, 400);  // Summary
  sheet.setColumnWidth(6, 300);  // Error
}

/**
 * Delete the config sheet (for testing/reset purposes)
 * WARNING: This will delete all your configuration!
 */
function deleteConfigSheet() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID');

  if (!sheetId) {
    console.log('No CONFIG_SHEET_ID found in Script Properties');
    return;
  }

  try {
    DriveApp.getFileById(sheetId).setTrashed(true);
    PropertiesService.getScriptProperties().deleteProperty('CONFIG_SHEET_ID');
    console.log('Config sheet deleted and moved to trash');
  } catch (e) {
    console.error('Failed to delete config sheet:', e.message);
  }
}
