/**
 * GmailService.gs - Gmail operations (fetch, label management)
 *
 * Handles all Gmail interactions:
 * - Fetching emails by label
 * - Removing labels after processing
 * - Creating labels for job configuration
 * - Formatting emails for LLM analysis
 *
 * Email bodies are truncated to MAX_BODY_LENGTH (2000 chars) to stay
 * within LLM context limits and reduce costs.
 *
 * @fileoverview Gmail service layer for email operations
 */

// Maximum body length to include in LLM context (coarse per-email upper bound)
const MAX_BODY_LENGTH = 2000;

// Total character budget for all email bodies in a single LLM request. The
// per-email cap is derived from this and the email count, so the total prompt
// size stays bounded regardless of how many emails are in the batch.
const LLM_CHAR_BUDGET = 24000;

// Never trim an individual email body below this many characters.
const MIN_BODY_CHARS = 300;

/**
 * Fetch emails with a specific label
 * @param {string} labelName - Full label name (e.g., "MailBot/Urgent")
 * @returns {Array<Object>} Array of email objects
 */
function fetchEmailsWithLabel(labelName) {
  const label = GmailApp.getUserLabelByName(labelName);

  if (!label) {
    console.log(`Label "${labelName}" not found`);
    return [];
  }

  const threads = label.getThreads();
  const emails = [];

  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const message of messages) {
      // Check if this specific message has the label (thread-level check already done)
      emails.push({
        id: message.getId(),
        threadId: thread.getId(),
        subject: message.getSubject(),
        from: message.getFrom(),
        to: message.getTo(),
        date: message.getDate(),
        body: truncateBody_(bodyText_(message)),
        snippet: thread.getFirstMessageSubject() // Brief preview
      });
    }
  }

  return emails;
}

/**
 * Remove a label from all threads containing the given message IDs
 * @param {string} labelName - Full label name
 * @param {Array<Object>} emails - Array of email objects with threadId
 */
function removeLabelFromEmails(labelName, emails) {
  const label = GmailApp.getUserLabelByName(labelName);

  if (!label) {
    console.log(`Label "${labelName}" not found, cannot remove`);
    return;
  }

  // Get unique thread IDs
  const threadIds = [...new Set(emails.map(e => e.threadId))];

  for (const threadId of threadIds) {
    try {
      const thread = GmailApp.getThreadById(threadId);
      if (thread) {
        thread.removeLabel(label);
      }
    } catch (e) {
      console.error(`Failed to remove label from thread ${threadId}:`, e.message);
    }
  }
}

/**
 * Get the best text representation of a message body. Prefers the plain-text
 * part (Gmail renders HTML-only mail down to text for us); falls back to a
 * crude tag-strip of the HTML part when the plain body is empty.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message
 * @returns {string} Body text (HTML tags removed)
 */
function bodyText_(message) {
  var plain = message.getPlainBody();
  if (plain && plain.trim()) {
    return plain;
  }

  // Fallback: HTML-only email with no usable plain part — strip tags crudely.
  return (message.getBody() || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Remove quoted reply history and signatures from a plain-text body. Operates
 * line-by-line, so it must run BEFORE any whitespace collapse.
 * @param {string} body - Plain-text body
 * @returns {string} Body with quoted history and signature removed
 */
function stripQuotedText_(body) {
  if (!body) return '';

  var lines = body.split(/\r?\n/);
  var kept = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Everything from a reply attribution / forwarded header down is history.
    if (/^\s*On .+wrote:\s*$/.test(line) ||
        /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
        /^\s*_{5,}\s*$/.test(line) ||
        /^\s*From:\s.+\bSent:\s/i.test(line)) {
      break;
    }

    // Signature delimiter ("-- " on its own line) — drop the rest.
    if (/^--\s*$/.test(line)) {
      break;
    }

    // Individual quoted lines.
    if (/^\s*>/.test(line)) {
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n');
}

/**
 * Clean and truncate an email body to stay within LLM context limits.
 * Order matters: strip quotes/signatures (line-based) BEFORE collapsing
 * whitespace, then remove link/boilerplate noise, then apply the char cap.
 * @param {string} body - Full email body
 * @returns {string} Cleaned, truncated body
 */
function truncateBody_(body) {
  if (!body) return '';

  // 1. Drop quoted reply history and signatures (needs line structure).
  body = stripQuotedText_(body);

  // 2. Collapse long tracking/unsubscribe URLs to a placeholder. (We avoid
  //    deleting whole "boilerplate" lines — that risked stripping context the
  //    LLM needs to judge importance, e.g. security-alert reassurance text.)
  body = body.replace(/https?:\/\/\S+/g, '[link]');

  // 3. Collapse remaining whitespace.
  body = body.replace(/\s+/g, ' ').trim();

  if (body.length <= MAX_BODY_LENGTH) {
    return body;
  }

  return body.substring(0, MAX_BODY_LENGTH) + '... [truncated]';
}

/**
 * Format emails into a text block for LLM processing
 * @param {Array<Object>} emails - Array of email objects
 * @returns {string} Formatted text
 */
function formatEmailsForLLM(emails) {
  if (emails.length === 0) {
    return 'No emails to process.';
  }

  // Divide the total budget across the batch so the overall prompt size stays
  // bounded no matter how many emails there are (with a per-email floor).
  const perEmail = Math.max(MIN_BODY_CHARS, Math.floor(LLM_CHAR_BUDGET / emails.length));

  const formatted = emails.map((email, index) => {
    let body = email.body || '';
    if (body.length > perEmail) {
      body = body.substring(0, perEmail) + '... [trimmed]';
    }

    return `--- Email ${index + 1} ---
From: ${email.from}
To: ${email.to}
Date: ${email.date}
Subject: ${email.subject}

${body}
`;
  });

  return formatted.join('\n');
}

/**
 * Create a Gmail label if it doesn't exist
 * @param {string} labelName - Full label name (can include "/" for nesting)
 * @returns {GoogleAppsScript.Gmail.GmailLabel}
 */
function getOrCreateLabel(labelName) {
  let label = GmailApp.getUserLabelByName(labelName);

  if (!label) {
    label = GmailApp.createLabel(labelName);
    console.log(`Created label: ${labelName}`);
  }

  return label;
}

/**
 * Get all user-defined Gmail labels
 * @returns {Array<string>} Array of label names
 */
function getAllUserLabels() {
  var labels = GmailApp.getUserLabels();
  var names = [];
  for (var i = 0; i < labels.length; i++) {
    try {
      names.push(labels[i].getName());
    } catch (e) {
      // GmailApp.getUserLabels() can hand back a stale/unresolvable label
      // handle ("Could not locate target object..."), typically transient or
      // a label that changed mid-run. Skip it rather than aborting the whole
      // job - this list is only a hint to the LLM.
      console.warn('Skipping unreadable label handle: ' + e.message);
    }
  }
  return names;
}

/**
 * Star a Gmail thread (stars all messages in the thread)
 * @param {string} threadId - Thread ID to star
 * @returns {boolean} Success status
 */
function starThread(threadId) {
  try {
    var thread = GmailApp.getThreadById(threadId);
    if (thread) {
      // Star all messages in the thread
      var messages = thread.getMessages();
      for (var i = 0; i < messages.length; i++) {
        messages[i].star();
      }
      console.log('Starred thread: ' + threadId);
      return true;
    }
    console.log('Thread not found for starring: ' + threadId);
    return false;
  } catch (e) {
    console.error('Failed to star thread ' + threadId + ': ' + e.message);
    return false;
  }
}

/**
 * Apply labels to a Gmail thread
 * @param {string} threadId - Thread ID
 * @param {Array<string>} labelNames - Array of label names to apply
 * @param {string} prefix - Optional prefix for new labels (e.g., "MailBot/")
 * @returns {Object} Result with applied labels and any errors
 */
function applyLabelsToThread(threadId, labelNames, prefix) {
  var result = {
    applied: [],
    created: [],
    errors: []
  };

  if (!labelNames || labelNames.length === 0) {
    return result;
  }

  try {
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) {
      result.errors.push('Thread not found: ' + threadId);
      return result;
    }

    for (var i = 0; i < labelNames.length; i++) {
      var labelName = labelNames[i];

      // Apply prefix if specified and label doesn't already have it
      var fullLabelName = labelName;
      if (prefix && labelName.indexOf(prefix) !== 0) {
        fullLabelName = prefix + labelName;
      }

      try {
        // Try to get existing label first
        var label = GmailApp.getUserLabelByName(fullLabelName);

        if (!label) {
          // Also check without prefix in case it exists
          label = GmailApp.getUserLabelByName(labelName);
        }

        if (!label) {
          // Create new label with prefix
          label = GmailApp.createLabel(fullLabelName);
          result.created.push(fullLabelName);
          console.log('Created new label: ' + fullLabelName);
        }

        thread.addLabel(label);
        result.applied.push(label.getName());
      } catch (labelError) {
        result.errors.push('Failed to apply label ' + fullLabelName + ': ' + labelError.message);
      }
    }
  } catch (e) {
    result.errors.push('Failed to process thread: ' + e.message);
  }

  return result;
}

/**
 * Test function for Gmail operations
 */
function testGmailService() {
  // Test fetching (won't work without actual label)
  console.log('Testing Gmail service...');

  // List all labels
  var labels = getAllUserLabels();
  console.log('Available labels:', labels);

  console.log('Gmail service test complete');
}
