/**
 * SidebarController.gs - Server-side functions for the sidebar UI
 *
 * This file contains all server-side functions called from the sidebar HTML.
 * Functions prefixed with 'sidebar' are called via google.script.run from
 * the client-side JavaScript in Sidebar.html.
 *
 * Features:
 * - Job management (run, dry run)
 * - Scheduler control (start/stop)
 * - Configuration validation
 * - Gmail label creation
 * - Health checks and statistics
 * - Daily health report notifications
 * - Gmail filter instructions
 *
 * @fileoverview Server-side sidebar controller for MailBot management UI
 */

/**
 * Show the MailBot sidebar
 * Can be called from the spreadsheet menu or directly
 */
function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('src/Sidebar')
    .setTitle('MailBot')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Add custom menu to the spreadsheet (simple trigger)
 * This runs automatically when the spreadsheet is opened
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('📧 MailBot')
    .addItem('Open Control Panel', 'showSidebar')
    .addSeparator()
    .addItem('Run All Jobs Now', 'runAllJobsNow')
    .addItem('Health Check', 'healthCheck')
    .addToUi();

  // Show a toast reminder about the control panel
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Click 📧 MailBot → Open Control Panel',
    'MailBot Ready',
    5
  );
}

/**
 * Install the sidebar menu into the config spreadsheet
 * Run this once after creating the config sheet
 */
function installSidebarMenu() {
  // Get the config sheet ID
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('CONFIG_SHEET_ID');

  if (!sheetId) {
    throw new Error('CONFIG_SHEET_ID not set. Run createConfigSheet first.');
  }

  // Create an installable onOpen trigger for the spreadsheet
  var triggers = ScriptApp.getProjectTriggers();

  // Check if trigger already exists
  var hasOnOpenTrigger = triggers.some(function(t) {
    return t.getHandlerFunction() === 'onOpen' &&
           t.getEventType() === ScriptApp.EventType.ON_OPEN;
  });

  if (!hasOnOpenTrigger) {
    var ss = SpreadsheetApp.openById(sheetId);
    ScriptApp.newTrigger('onOpen')
      .forSpreadsheet(ss)
      .onOpen()
      .create();
    console.log('Installed onOpen trigger for spreadsheet');
  } else {
    console.log('onOpen trigger already exists');
  }

  // Also run onOpen now to add the menu immediately
  try {
    onOpen();
    console.log('Menu added to spreadsheet');
  } catch (e) {
    console.log('Could not add menu immediately (spreadsheet may not be open): ' + e.message);
  }

  console.log('Sidebar menu installed! Open the spreadsheet and look for the "📧 MailBot" menu.');
}

/**
 * Get list of jobs for the sidebar dropdown
 */
function sidebarGetJobs() {
  var jobs = loadJobs();
  return jobs.map(function(job) {
    return {
      name: job.jobName,
      enabled: job.enabled
    };
  });
}

/**
 * Run a specific job by name
 */
function sidebarRunJob(jobName, dryRun) {
  try {
    var settings = loadSettings();
    var jobs = loadJobs();
    var job = jobs.find(function(j) { return j.jobName === jobName; });

    if (!job) {
      return { success: false, error: 'Job not found: ' + jobName };
    }

    var options = { dryRun: dryRun || false };
    var result = executeJob(job, settings, options);

    // Don't update job status or log execution in dry run mode
    if (!dryRun) {
      // Update job status
      var now = new Date();
      updateJobStatus(
        job.rowIndex,
        now,
        result.success ? 'success' : 'error',
        result.emailCount,
        result.error
      );

      // Log execution
      logExecution(
        job.jobName,
        result.success ? 'success' : 'error',
        result.emailCount,
        result.summary,
        result.error
      );
    }

    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Run all enabled jobs
 */
function sidebarRunAllJobs() {
  try {
    var settings = loadSettings();
    var jobs = loadJobs();
    var jobsRun = 0;
    var jobsFailed = 0;

    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      if (!job.enabled) continue;

      var result = executeJob(job, settings);

      var now = new Date();
      updateJobStatus(
        job.rowIndex,
        now,
        result.success ? 'success' : 'error',
        result.emailCount,
        result.error
      );

      logExecution(
        job.jobName,
        result.success ? 'success' : 'error',
        result.emailCount,
        result.summary,
        result.error
      );

      if (result.success) {
        jobsRun++;
      } else {
        jobsFailed++;
      }
    }

    return { jobsRun: jobsRun, jobsFailed: jobsFailed };
  } catch (e) {
    return { jobsRun: 0, jobsFailed: 0, error: e.message };
  }
}

/**
 * Send a test notification
 */
function sidebarTestNotification() {
  try {
    var settings = loadSettings();
    var notifier = NotifierFactory.create(settings.NOTIFIER || 'googlechat', settings);

    var success = notifier.send(
      'Test Notification',
      'This is a test message from MailBot.\n\nIf you can read this, notifications are working!'
    );

    return { success: success, error: success ? null : 'Failed to send notification' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Validate the configuration
 */
function sidebarValidateConfig() {
  var issues = [];

  try {
    var settings = loadSettings();

    // Check LLM provider config
    var provider = settings.LLM_PROVIDER || 'anthropic';
    if (provider === 'anthropic' && !settings.ANTHROPIC_API_KEY) {
      issues.push('ANTHROPIC_API_KEY is not set');
    }
    if (provider === 'gemini' && !settings.GEMINI_API_KEY) {
      issues.push('GEMINI_API_KEY is not set');
    }

    // Check notifier config
    var notifierType = settings.NOTIFIER || 'googlechat';
    if (notifierType === 'googlechat' && !settings.GOOGLE_CHAT_WEBHOOK_URL) {
      issues.push('GOOGLE_CHAT_WEBHOOK_URL is not set');
    }

    // Check jobs
    var jobs = loadJobs();
    if (jobs.length === 0) {
      issues.push('No jobs configured');
    }

    // Check labels exist
    var enabledJobs = jobs.filter(function(j) { return j.enabled; });
    for (var i = 0; i < enabledJobs.length; i++) {
      var job = enabledJobs[i];
      var label = GmailApp.getUserLabelByName(job.label);
      if (!label) {
        issues.push('Gmail label not found: ' + job.label);
      }
    }

    // Test LLM API key (quick validation)
    if (issues.length === 0) {
      try {
        var llm = LLMFactory.create(provider, settings);
        // We could do a minimal API call here, but that costs money
        // Just check that the provider was created successfully
      } catch (e) {
        issues.push('LLM provider error: ' + e.message);
      }
    }

  } catch (e) {
    issues.push('Config error: ' + e.message);
  }

  return { issues: issues };
}

/**
 * Create Gmail labels from job configuration
 */
function sidebarCreateLabels() {
  var labels = [];

  try {
    var jobs = loadJobs();

    for (var i = 0; i < jobs.length; i++) {
      var labelName = jobs[i].label;
      if (labelName) {
        getOrCreateLabel(labelName);
        labels.push(labelName);
      }
    }
  } catch (e) {
    return { labels: [], error: e.message };
  }

  return { labels: labels };
}

/**
 * Health check
 */
function sidebarHealthCheck() {
  var checks = {
    config: false,
    settings: false,
    jobs: false,
    gmail: false,
    trigger: false
  };

  try {
    loadSettings();
    checks.config = true;
    checks.settings = true;
  } catch (e) {
    // Config failed
  }

  try {
    var jobs = loadJobs();
    checks.jobs = jobs.length > 0;
  } catch (e) {
    // Jobs failed
  }

  try {
    GmailApp.getUserLabels();
    checks.gmail = true;
  } catch (e) {
    // Gmail failed
  }

  try {
    var triggers = ScriptApp.getProjectTriggers();
    checks.trigger = triggers.some(function(t) {
      return t.getHandlerFunction() === 'runJobs';
    });
  } catch (e) {
    // Triggers check failed
  }

  return checks;
}

/**
 * Start the scheduler
 */
function sidebarStartScheduler() {
  // Remove existing triggers first
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runJobs') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create new trigger
  ScriptApp.newTrigger('runJobs')
    .timeBased()
    .everyMinutes(5)
    .create();

  return { success: true };
}

/**
 * Stop the scheduler
 */
function sidebarStopScheduler() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runJobs') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  return { success: true, removed: removed };
}

/**
 * Get Gmail filter suggestions based on job configuration
 * @returns {Object} Filter suggestions for each job
 */
function sidebarGetFilterSuggestions() {
  var jobs = loadJobs();
  var suggestions = [];

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (!job.label) continue;

    suggestions.push({
      jobName: job.jobName,
      label: job.label,
      instructions: [
        '1. Go to Gmail → Settings (gear icon) → See all settings',
        '2. Click "Filters and Blocked Addresses" tab',
        '3. Click "Create a new filter"',
        '4. Set your filter criteria:',
        '   • For all mail: leave criteria empty, click "Create filter"',
        '   • For primary inbox: use "category:primary"',
        '   • For specific senders: enter email addresses',
        '5. Check "Apply the label" and select "' + job.label + '"',
        '   (Create the label if it doesn\'t exist)',
        '6. Optionally check "Also apply to matching conversations"',
        '7. Click "Create filter"'
      ]
    });
  }

  return { suggestions: suggestions };
}

/**
 * Get execution statistics from the ExecutionLog
 * @returns {Object} Execution statistics
 */
function sidebarGetStatistics() {
  try {
    var sheet = getSheet_(EXECUTION_LOG_TAB);
    var data = sheet.getDataRange().getValues();

    // Skip header row
    if (data.length <= 1) {
      return {
        totalRuns: 0,
        successCount: 0,
        errorCount: 0,
        successRate: 0,
        totalEmailsProcessed: 0,
        runsToday: 0,
        runsThisWeek: 0,
        lastRun: null,
        lastError: null,
        jobStats: []
      };
    }

    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    var totalRuns = 0;
    var successCount = 0;
    var errorCount = 0;
    var totalEmailsProcessed = 0;
    var runsToday = 0;
    var runsThisWeek = 0;
    var lastRun = null;
    var lastError = null;
    var jobStatsMap = {};

    // Process rows (skip header)
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var timestamp = row[0];
      var jobName = row[1];
      var status = row[2];
      var emailsProcessed = row[3] || 0;
      var errorMsg = row[5];

      if (!timestamp) continue;

      totalRuns++;
      var runDate = new Date(timestamp);

      if (status === 'success') {
        successCount++;
      } else {
        errorCount++;
        if (!lastError || runDate > new Date(lastError.timestamp)) {
          lastError = { timestamp: timestamp, jobName: jobName, error: errorMsg };
        }
      }

      totalEmailsProcessed += emailsProcessed;

      if (runDate >= todayStart) runsToday++;
      if (runDate >= weekStart) runsThisWeek++;

      if (!lastRun || runDate > new Date(lastRun)) {
        lastRun = timestamp;
      }

      // Per-job stats
      if (!jobStatsMap[jobName]) {
        jobStatsMap[jobName] = { runs: 0, success: 0, emails: 0 };
      }
      jobStatsMap[jobName].runs++;
      if (status === 'success') jobStatsMap[jobName].success++;
      jobStatsMap[jobName].emails += emailsProcessed;
    }

    var jobStats = [];
    for (var name in jobStatsMap) {
      var stats = jobStatsMap[name];
      jobStats.push({
        jobName: name,
        runs: stats.runs,
        successRate: stats.runs > 0 ? Math.round((stats.success / stats.runs) * 100) : 0,
        totalEmails: stats.emails
      });
    }

    return {
      totalRuns: totalRuns,
      successCount: successCount,
      errorCount: errorCount,
      successRate: totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0,
      totalEmailsProcessed: totalEmailsProcessed,
      runsToday: runsToday,
      runsThisWeek: runsThisWeek,
      lastRun: lastRun,
      lastError: lastError,
      jobStats: jobStats
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Start the daily health check trigger
 */
function sidebarStartHealthCheck() {
  // Remove existing health check triggers
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendHealthNotification') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create daily trigger at 9 AM
  ScriptApp.newTrigger('sendHealthNotification')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  return { success: true };
}

/**
 * Stop the daily health check trigger
 */
function sidebarStopHealthCheck() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendHealthNotification') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  return { success: true, removed: removed };
}

/**
 * Check if health notification trigger is active
 */
function sidebarIsHealthCheckActive() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendHealthNotification') {
      return { active: true };
    }
  }
  return { active: false };
}

/**
 * Send daily health notification
 * Called by time-based trigger
 */
function sendHealthNotification() {
  try {
    var settings = loadSettings();
    var stats = sidebarGetStatistics();

    var notifier = NotifierFactory.create(
      settings.NOTIFIER || 'googlechat',
      settings
    );

    var lines = [];
    lines.push('Daily Health Report');
    lines.push('');
    lines.push('Runs today: ' + stats.runsToday);
    lines.push('Runs this week: ' + stats.runsThisWeek);
    lines.push('Success rate: ' + stats.successRate + '%');
    lines.push('Total emails processed: ' + stats.totalEmailsProcessed);

    if (stats.lastError) {
      lines.push('');
      lines.push('Last error: ' + stats.lastError.jobName + ' - ' + stats.lastError.error);
    }

    // Check if scheduler is running
    var schedulerRunning = false;
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'runJobs') {
        schedulerRunning = true;
        break;
      }
    }

    if (!schedulerRunning) {
      lines.push('');
      lines.push('⚠️ WARNING: Scheduler is not running!');
    }

    notifier.send('MailBot Health Check', lines.join('\n'));
  } catch (e) {
    console.error('Health notification failed:', e.message);
  }
}
