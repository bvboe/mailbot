/**
 * JobRunner.gs - Job execution logic and scheduling checks
 *
 * Handles the core job processing logic:
 * - Schedule evaluation (interval-based or specific times)
 * - Email fetching and LLM analysis
 * - Notification sending based on conditions
 * - Label cleanup after processing
 *
 * Supports two schedule types:
 * - 'interval': Run every N minutes (e.g., every 5 minutes)
 * - 'specific_times': Run at specific times (e.g., "08:00,12:00,18:00")
 *
 * Supports dry-run mode for testing without making changes.
 * Verbose logging can be enabled via LOG_LEVEL setting.
 *
 * @fileoverview Job execution engine for MailBot
 */

/**
 * Check if a job should run based on its schedule
 * @param {Object} job - Job configuration object
 * @returns {boolean} Whether the job should run now
 */
function shouldJobRun(job) {
  if (!job.enabled) {
    return false;
  }

  const now = new Date();

  if (job.scheduleType === 'interval') {
    return shouldRunInterval_(job, now);
  } else if (job.scheduleType === 'specific_times') {
    return shouldRunAtSpecificTime_(job, now);
  }

  console.log(`Unknown schedule type for job ${job.jobName}: ${job.scheduleType}`);
  return false;
}

/**
 * Check if an interval-based job should run
 * @param {Object} job - Job configuration
 * @param {Date} now - Current time
 * @returns {boolean}
 */
function shouldRunInterval_(job, now) {
  const intervalMinutes = parseInt(job.scheduleValue, 10);

  if (isNaN(intervalMinutes) || intervalMinutes <= 0) {
    console.log(`Invalid interval for job ${job.jobName}: ${job.scheduleValue}`);
    return false;
  }

  // If never run, should run now
  if (!job.lastRun) {
    return true;
  }

  const lastRun = new Date(job.lastRun);
  const minutesSinceLastRun = (now - lastRun) / (1000 * 60);

  return minutesSinceLastRun >= intervalMinutes;
}

/**
 * Check if a specific-times job should run
 * @param {Object} job - Job configuration
 * @param {Date} now - Current time
 * @returns {boolean}
 */
function shouldRunAtSpecificTime_(job, now) {
  const times = job.scheduleValue.split(',').map(t => t.trim());
  const currentTimeStr = formatTime_(now);

  // Check if current time matches any scheduled time (within 5-minute window)
  for (const scheduledTime of times) {
    if (isWithinWindow_(currentTimeStr, scheduledTime, 5)) {
      // Check if we already ran at this time today
      if (job.lastRun) {
        const lastRun = new Date(job.lastRun);
        const lastRunTimeStr = formatTime_(lastRun);

        // If we ran today within the same window, skip
        if (isSameDay_(now, lastRun) && isWithinWindow_(lastRunTimeStr, scheduledTime, 5)) {
          return false;
        }
      }
      return true;
    }
  }

  return false;
}

/**
 * Format time as HH:MM string
 * @param {Date} date
 * @returns {string}
 */
function formatTime_(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Check if two times are within a window of each other
 * @param {string} time1 - HH:MM format
 * @param {string} time2 - HH:MM format
 * @param {number} windowMinutes - Allowed difference in minutes
 * @returns {boolean}
 */
function isWithinWindow_(time1, time2, windowMinutes) {
  const minutes1 = timeToMinutes_(time1);
  const minutes2 = timeToMinutes_(time2);
  return Math.abs(minutes1 - minutes2) <= windowMinutes;
}

/**
 * Convert HH:MM to minutes since midnight
 * @param {string} time - HH:MM format
 * @returns {number}
 */
function timeToMinutes_(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if two dates are on the same day
 * @param {Date} date1
 * @param {Date} date2
 * @returns {boolean}
 */
function isSameDay_(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

/**
 * Execute a single job
 * @param {Object} job - Job configuration
 * @param {Object} settings - Global settings
 * @param {Object} options - Execution options { dryRun: boolean }
 * @returns {Object} Execution result { success: boolean, emailCount: number, error: string }
 */
function executeJob(job, settings, options) {
  options = options || {};
  var dryRun = options.dryRun || false;
  var verbose = (settings.LOG_LEVEL === 'verbose');
  var labelPrefix = settings.LABEL_PREFIX || '';

  var result = {
    success: false,
    emailCount: 0,
    summary: '',
    error: '',
    warning: '',
    partial: false,
    dryRun: dryRun,
    starred: 0,
    labeled: 0
  };

  var prefix = dryRun ? '[DRY RUN] ' : '';

  try {
    // Step 1: Fetch emails with the job's label
    console.log(prefix + '[' + job.jobName + '] Fetching emails with label: ' + job.label);
    var emails = fetchEmailsWithLabel(job.label);

    if (emails.length === 0) {
      console.log(prefix + '[' + job.jobName + '] No emails found');
      result.success = true;
      result.summary = 'No emails to process';
      result.emailCount = 0;
      return result;
    }

    // Drain the whole backlog. BatchSize caps how many emails go to the LLM (or
    // webhook) in a SINGLE call (0/blank = all at once); we loop over chunks
    // until every labeled email is processed. Each chunk is an independent
    // analyze -> act -> notify -> unlabel cycle, so already-processed chunks are
    // durable even if a later chunk fails (its emails keep their label and are
    // retried next run).
    var chunkSize = job.batchSize > 0 ? job.batchSize : emails.length;
    var batchCount = Math.ceil(emails.length / chunkSize);
    console.log(prefix + '[' + job.jobName + '] Found ' + emails.length +
      ' emails; processing in ' + batchCount + ' batch(es) of up to ' + chunkSize);

    var summaries = [];
    var warnings = [];
    for (var start = 0; start < emails.length; start += chunkSize) {
      var chunk = emails.slice(start, start + chunkSize);
      if (batchCount > 1) {
        console.log(prefix + '[' + job.jobName + '] Batch ' +
          (Math.floor(start / chunkSize) + 1) + '/' + batchCount + ': emails ' +
          (start + 1) + '-' + (start + chunk.length));
      }

      var batch = processEmailBatch_(chunk, job, settings, dryRun, verbose, labelPrefix, prefix);

      // Accumulate incrementally so that if a LATER chunk throws, the status
      // logged for this run still reflects the chunks that already succeeded
      // (their labels are gone, so they won't be reprocessed).
      result.emailCount += chunk.length;
      result.starred += batch.starred;
      result.labeled += batch.labeled;
      if (batch.summary) {
        summaries.push(batch.summary);
        result.summary = summaries.join('\n\n---\n\n');
      }
      if (batch.warning) {
        warnings.push(batch.warning);
        result.warning = warnings.join(' | ');
      }
      if (batch.partial) {
        result.partial = true;
      }
    }

    if (!result.summary) {
      result.summary = 'Processed ' + result.emailCount + ' email(s)';
    }

    result.success = true;
    console.log(prefix + '[' + job.jobName + '] Job completed successfully');
    if (result.starred > 0 || result.labeled > 0) {
      console.log(prefix + '[' + job.jobName + '] Starred: ' + result.starred + ', Labeled: ' + result.labeled);
    }

  } catch (e) {
    result.success = false;
    result.error = e.message;
    console.error(prefix + '[' + job.jobName + '] Job failed: ' + e.message);

    if (verbose) {
      console.error(prefix + '[' + job.jobName + '] Stack: ' + e.stack);
    }

    // Try to send error notification (but not in dry run)
    if (!dryRun) {
      try {
        var settings_ = loadSettings();
        var errorNotifier = NotifierFactory.create(
          settings_.NOTIFIER || 'googlechat',
          settings_
        );
        errorNotifier.sendError('Job: ' + job.jobName, e.message);
      } catch (notifyError) {
        console.error('Failed to send error notification: ' + notifyError.message);
      }
    }
  }

  return result;
}

/**
 * Process a single chunk of emails: analyze (via the per-job webhook or the
 * configured LLM), apply per-email actions, notify, and remove the processing
 * label for this chunk. Throws on failure so the caller stops and leaves the
 * remaining chunks labeled for a retry.
 * @returns {Object} { starred, labeled, summary, warning, partial }
 */
function processEmailBatch_(emails, job, settings, dryRun, verbose, labelPrefix, prefix) {
  var batch = { starred: 0, labeled: 0, summary: '', warning: '', partial: false };

  if (verbose) {
    for (var i = 0; i < emails.length; i++) {
      console.log(prefix + '[' + job.jobName + '] Email ' + (i + 1) + ': ' + emails[i].subject + ' (from: ' + emails[i].from + ')');
    }
  }

  var analysis;

  if (job.webhookUrl) {
    // Webhook-override path: fire-and-forget. POST the chunk, expect a fast 2xx
    // ack; the webhook does the heavy processing (and its own notification)
    // asynchronously. If it returns an analysis body we use it, otherwise
    // MailBot does nothing further for this chunk.
    console.log(prefix + '[' + job.jobName + '] Forwarding ' + emails.length +
      ' email(s) to webhook: ' + job.webhookUrl);
    var webhookResult = sendJobToWebhook_(job, emails, settings);
    analysis = webhookResult.analysis; // analysis object, or null for a bare ack
    if (!analysis) {
      batch.summary = 'Forwarded ' + emails.length + ' email(s) to the webhook';
      console.log(prefix + '[' + job.jobName +
        '] Webhook accepted (2xx); MailBot will not notify/label/star for this batch');
    }
  } else {
    // Fetch existing labels if auto-labeling is enabled (LLM prompt hint).
    var existingLabels = [];
    if (job.autoLabel) {
      console.log(prefix + '[' + job.jobName + '] Fetching existing labels for auto-labeling...');
      existingLabels = getAllUserLabels();
      if (verbose) {
        console.log(prefix + '[' + job.jobName + '] Found ' + existingLabels.length + ' existing labels');
      }
    }

    // Format emails and send to the LLM (compression is per-job).
    var formattedContent = formatEmailsForLLM(emails, job.compression);

    if (verbose) {
      console.log(prefix + '[' + job.jobName + '] Formatted content length: ' + formattedContent.length + ' chars');
      console.log(prefix + '[' + job.jobName + '] Using prompt: ' + job.prompt.substring(0, 100) + '...');
    }

    var llmProvider = LLMFactory.create(
      settings.LLM_PROVIDER || 'anthropic',
      settings
    );

    console.log(prefix + '[' + job.jobName + '] Analyzing with LLM...');

    var llmOptions = {
      existingLabels: existingLabels,
      enableLabeling: job.autoLabel === true,
      enableStarring: job.autoStar === true
    };

    analysis = llmProvider.analyze(job.prompt, formattedContent, llmOptions);

    // Retry once on an incomplete/invented analysis (LLM path only - it re-runs
    // the model). Keep whichever attempt covered more of the chunk.
    var completeness = checkAnalysisCompleteness_(emails.length, analysis.emails);
    if (!completeness.complete) {
      console.warn(prefix + '[' + job.jobName + '] Analysis incomplete (covered ' +
        completeness.analyzed + '/' + emails.length + '), retrying once...');
      var retryAnalysis = llmProvider.analyze(job.prompt, formattedContent, llmOptions);
      var retryCompleteness = checkAnalysisCompleteness_(emails.length, retryAnalysis.emails);
      if (retryCompleteness.complete || retryCompleteness.analyzed > completeness.analyzed) {
        analysis = retryAnalysis;
      }
    }
  }

  // Post-analysis processing runs only when we actually have an analysis object
  // (the LLM path, or a webhook that returned one). A bare webhook ack skips to
  // label removal below.
  if (analysis) {
    annotateCompleteness_(batch, analysis, emails.length, prefix, job.jobName);

    if (verbose) {
      console.log(prefix + '[' + job.jobName + '] LLM summary length: ' + analysis.summary.length + ' chars');
      console.log(prefix + '[' + job.jobName + '] LLM isImportant: ' + analysis.isImportant);
      console.log(prefix + '[' + job.jobName + '] LLM emails array: ' + JSON.stringify(analysis.emails));
    }

    // Per-email actions (starring and labeling).
    if (analysis.emails && analysis.emails.length > 0) {
      processEmailActions_(emails, analysis.emails, job, labelPrefix, dryRun, verbose, prefix, batch);
    }

    // Decide whether to notify based on condition.
    var shouldNotify = false;
    if (job.notifyCondition === 'always') {
      shouldNotify = true;
    } else if (job.notifyCondition === 'conditional') {
      shouldNotify = analysis.isImportant;
      if (!shouldNotify) {
        console.log(prefix + '[' + job.jobName + '] LLM says not important, skipping notification');
      }
    }

    if (shouldNotify) {
      if (dryRun) {
        console.log(prefix + '[' + job.jobName + '] Would send notification (skipped in dry run)');
        console.log(prefix + '[' + job.jobName + '] Notification content: ' + analysis.summary.substring(0, 200) + '...');
      } else {
        var notifier = NotifierFactory.create(
          settings.NOTIFIER || 'googlechat',
          settings
        );

        console.log('[' + job.jobName + '] Sending notification...');
        var title = job.jobName + ': ' + emails.length + ' email(s)';
        notifier.send(title, analysis.summary);
      }
    }
  }

  // Remove the processing label for this chunk (reached only on success, so a
  // failed chunk keeps its label and is retried on the next run).
  if (dryRun) {
    console.log(prefix + '[' + job.jobName + '] Would remove labels from ' + emails.length + ' emails (skipped in dry run)');
  } else {
    console.log('[' + job.jobName + '] Removing labels from processed emails...');
    removeLabelFromEmails(job.label, emails);
  }

  return batch;
}

/**
 * Run the completeness check against an analysis and record the outcome on the
 * result: set result.summary/partial, and on a partial/invented analysis log a
 * warning, set result.warning, and append a human-facing note to the summary.
 * Shared by the LLM path and a webhook that returns an analysis body.
 * @param {Object} result - Result object to update (mutated)
 * @param {Object} analysis - { summary, isImportant, emails }
 * @param {number} emailCount - Number of emails sent
 * @param {string} prefix - Log prefix
 * @param {string} jobName - Job name for logs
 */
function annotateCompleteness_(result, analysis, emailCount, prefix, jobName) {
  var completeness = checkAnalysisCompleteness_(emailCount, analysis.emails);
  result.summary = analysis.summary;
  result.partial = !completeness.complete;

  if (completeness.complete) {
    return;
  }

  var incomplete = completeness.missing.length > 0;
  var invented = completeness.hallucinated.length > 0;

  var warn = 'Analysis issue: covered ' + completeness.analyzed + ' of ' +
    emailCount + ' emails';
  if (incomplete) {
    warn += '; missing: ' + completeness.missing.join(',');
  }
  if (invented) {
    warn += '; invalid indices: ' + completeness.hallucinated.join(',');
  }
  console.warn(prefix + '[' + jobName + '] ' + warn);
  result.warning = warn;

  // Tailor the human-facing note to what actually went wrong.
  var note;
  if (incomplete && invented) {
    note = 'This digest may be incomplete and may reference emails that were not sent.';
  } else if (incomplete) {
    note = 'This digest may be incomplete.';
  } else {
    note = 'The model referenced email(s) that were not sent, so some details may be invented.';
  }

  analysis.summary = analysis.summary + '\n\n⚠️ _' + warn + '. ' + note + '_';
  result.summary = analysis.summary;
}

/**
 * Detect a partial or hallucinated analysis by comparing the LLM's per-email
 * results against the emails we actually sent. Both failure modes otherwise
 * pass silently (valid JSON, done_reason=stop), so we surface them.
 * @param {number} emailCount - Number of emails sent to the LLM
 * @param {Array} llmEmails - analysis.emails array (each with an .index)
 * @returns {Object} { complete, analyzed, missing: [], hallucinated: [] }
 */
function checkAnalysisCompleteness_(emailCount, llmEmails) {
  var seen = {};
  var hallucinated = [];
  var list = llmEmails || [];

  for (var i = 0; i < list.length; i++) {
    var idx = list[i] ? list[i].index : undefined;
    // Out-of-range, non-numeric, or duplicate index = invented/unreliable.
    if (typeof idx !== 'number' || idx < 0 || idx >= emailCount || seen[idx]) {
      hallucinated.push(idx);
    } else {
      seen[idx] = true;
    }
  }

  var missing = [];
  for (var j = 0; j < emailCount; j++) {
    if (!seen[j]) {
      missing.push(j);
    }
  }

  return {
    complete: missing.length === 0 && hallucinated.length === 0,
    analyzed: Object.keys(seen).length,
    missing: missing,
    hallucinated: hallucinated
  };
}

/**
 * Process per-email actions (starring and labeling) from LLM response
 * @param {Array} emails - Original email array with threadId
 * @param {Array} llmEmails - LLM response array with actions per email
 * @param {Object} job - Job configuration (for autoStar, autoLabel flags)
 * @param {string} labelPrefix - Prefix for new labels
 * @param {boolean} dryRun - Whether this is a dry run
 * @param {boolean} verbose - Whether to log verbose output
 * @param {string} prefix - Log prefix string
 * @param {Object} result - Result object to update
 * @returns {Object} Updated result object
 */
function processEmailActions_(emails, llmEmails, job, labelPrefix, dryRun, verbose, prefix, result) {
  for (var i = 0; i < llmEmails.length; i++) {
    var llmEmail = llmEmails[i];
    var emailIndex = llmEmail.index;

    // Validate index
    if (emailIndex < 0 || emailIndex >= emails.length) {
      console.log(prefix + 'Warning: Invalid email index ' + emailIndex + ', skipping');
      continue;
    }

    var email = emails[emailIndex];
    var threadId = email.threadId;

    // Process starring
    if (job.autoStar && llmEmail.star === true) {
      if (dryRun) {
        console.log(prefix + 'Would star thread for email: ' + email.subject);
        result.starred++;
      } else {
        if (starThread(threadId)) {
          result.starred++;
          if (verbose) {
            console.log(prefix + 'Starred thread for email: ' + email.subject);
          }
        }
      }
    }

    // Process labeling
    if (job.autoLabel && llmEmail.addLabels && llmEmail.addLabels.length > 0) {
      if (dryRun) {
        console.log(prefix + 'Would apply labels to email "' + email.subject + '": ' + llmEmail.addLabels.join(', '));
        result.labeled++;
      } else {
        var labelResult = applyLabelsToThread(threadId, llmEmail.addLabels, labelPrefix);

        if (labelResult.applied.length > 0) {
          result.labeled++;
          if (verbose) {
            console.log(prefix + 'Applied labels to "' + email.subject + '": ' + labelResult.applied.join(', '));
          }
        }

        if (labelResult.created.length > 0) {
          console.log(prefix + 'Created new labels: ' + labelResult.created.join(', '));
        }

        if (labelResult.errors.length > 0) {
          console.log(prefix + 'Label errors: ' + labelResult.errors.join('; '));
        }
      }
    }
  }

  return result;
}
