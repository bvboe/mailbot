/**
 * Main.gs - Entry point and trigger handlers for MailBot
 *
 * This is a Gmail bot that:
 * 1. Monitors Gmail for emails with specific labels (applied by Gmail filters)
 * 2. Analyzes them using an LLM (Anthropic Claude or Google Gemini)
 * 3. Sends summaries via Google Chat webhooks
 * 4. Removes labels from processed emails to prevent reprocessing
 *
 * The scheduler runs every 5 minutes and checks each job's schedule
 * to determine if it should run.
 *
 * @fileoverview Main entry point for MailBot Gmail monitoring bot
 */

/**
 * Main entry point - runs all due jobs
 * This should be triggered every 5 minutes by a time-based trigger.
 */
function runJobs() {
  console.log('MailBot starting...');

  try {
    // Load configuration
    const settings = loadSettings();
    const jobs = loadJobs();

    console.log(`Loaded ${jobs.length} jobs`);

    let jobsRun = 0;
    let jobsFailed = 0;

    // Process each job
    for (const job of jobs) {
      if (!shouldJobRun(job)) {
        console.log(`Skipping job: ${job.jobName} (not scheduled or disabled)`);
        continue;
      }

      console.log(`Running job: ${job.jobName}`);
      const result = executeJob(job, settings);

      // Update job status in sheet
      const now = new Date();
      updateJobStatus(
        job.rowIndex,
        now,
        result.success ? 'success' : 'error',
        result.emailCount,
        result.error || result.warning
      );

      // Log execution (surface partial-analysis warnings even on success)
      logExecution(
        job.jobName,
        result.success ? 'success' : 'error',
        result.emailCount,
        result.summary,
        result.error || result.warning
      );

      if (result.success) {
        jobsRun++;
      } else {
        jobsFailed++;
      }
    }

    console.log(`MailBot finished. Jobs run: ${jobsRun}, failed: ${jobsFailed}`);

  } catch (e) {
    console.error('MailBot fatal error:', e.message);
    logError('Main.runJobs', e);

    // Try to notify about the fatal error
    try {
      const settings = loadSettings();
      const notifier = NotifierFactory.create(
        settings.NOTIFIER || 'googlechat',
        settings
      );
      notifier.sendError('MailBot Fatal Error', e.message);
    } catch (notifyError) {
      console.error('Failed to send fatal error notification:', notifyError.message);
    }
  }
}

/**
 * Manual test function - runs all enabled jobs regardless of schedule
 */
function runAllJobsNow() {
  console.log('Running all jobs manually...');

  const settings = loadSettings();
  const jobs = loadJobs();

  for (const job of jobs) {
    if (!job.enabled) {
      console.log(`Skipping disabled job: ${job.jobName}`);
      continue;
    }

    console.log(`Running job: ${job.jobName}`);
    const result = executeJob(job, settings);

    // Update job status
    const now = new Date();
    updateJobStatus(
      job.rowIndex,
      now,
      result.success ? 'success' : 'error',
      result.emailCount,
      result.error || result.warning
    );

    // Log execution (surface partial-analysis warnings even on success)
    logExecution(
      job.jobName,
      result.success ? 'success' : 'error',
      result.emailCount,
      result.summary,
      result.error || result.warning
    );

    console.log(`Job ${job.jobName} result:`, result.success ? 'success' : 'failed');
  }

  console.log('Manual run complete');
}

/**
 * Set up the time-based trigger programmatically
 * Run this once to create the trigger.
 */
function setupTrigger() {
  // Delete existing triggers for this function
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'runJobs') {
      ScriptApp.deleteTrigger(trigger);
      console.log('Deleted existing runJobs trigger');
    }
  }

  // Create new trigger - every 5 minutes
  ScriptApp.newTrigger('runJobs')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log('Created new trigger: runJobs every 5 minutes');
}

/**
 * Remove all triggers for this script
 */
function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    ScriptApp.deleteTrigger(trigger);
    console.log(`Deleted trigger: ${trigger.getHandlerFunction()}`);
  }
  console.log('All triggers removed');
}

/**
 * Initialize the project - run this once after setup
 */
function initialize() {
  console.log('Initializing MailBot...');

  // Test config loading
  try {
    const settings = loadSettings();
    console.log('Settings loaded successfully');
    console.log('LLM Provider:', settings.LLM_PROVIDER || 'gemini (default)');
    console.log('Notifier:', settings.NOTIFIER || 'googlechat (default)');

    const jobs = loadJobs();
    console.log(`Found ${jobs.length} jobs:`);
    jobs.forEach(j => console.log(`  - ${j.jobName} (${j.enabled ? 'enabled' : 'disabled'})`));

  } catch (e) {
    console.error('Config loading failed:', e.message);
    console.error('Make sure CONFIG_SHEET_ID is set in Script Properties');
    return;
  }

  // Initialize log sheet
  try {
    initializeLogSheet();
    console.log('ExecutionLog sheet initialized');
  } catch (e) {
    console.error('Failed to initialize log sheet:', e.message);
  }

  console.log('Initialization complete!');
  console.log('Next steps:');
  console.log('1. Verify your Settings and Jobs sheets are configured');
  console.log('2. Set up Gmail rules to apply labels to incoming emails');
  console.log('3. Run setupTrigger() to enable automatic execution');
}

/**
 * Quick health check
 */
function healthCheck() {
  const checks = {
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
    console.error('Config check failed:', e.message);
  }

  try {
    const jobs = loadJobs();
    checks.jobs = jobs.length > 0;
  } catch (e) {
    console.error('Jobs check failed:', e.message);
  }

  try {
    GmailApp.getUserLabels();
    checks.gmail = true;
  } catch (e) {
    console.error('Gmail check failed:', e.message);
  }

  const triggers = ScriptApp.getProjectTriggers();
  checks.trigger = triggers.some(t => t.getHandlerFunction() === 'runJobs');

  console.log('Health Check Results:');
  console.log('  Config accessible:', checks.config ? '✓' : '✗');
  console.log('  Settings loaded:', checks.settings ? '✓' : '✗');
  console.log('  Jobs configured:', checks.jobs ? '✓' : '✗');
  console.log('  Gmail accessible:', checks.gmail ? '✓' : '✗');
  console.log('  Trigger active:', checks.trigger ? '✓' : '✗');

  return checks;
}
