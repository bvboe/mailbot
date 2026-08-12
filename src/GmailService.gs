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

// URLs longer than this are collapsed to [link] (medium). Short, likely-useful
// URLs (product links, calendar links) are kept; long tracking/UTM URLs aren't.
const MAX_URL_LENGTH = 100;

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
        // Store the raw body; compression is applied per-job at format time
        // (so a 'none' compression setting can send full bodies).
        body: bodyText_(message),
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
 * Normalize a job's compression setting to a known level (default 'medium').
 * @param {string} level
 * @returns {string} 'none' | 'medium' | 'high'
 */
function normalizeCompression_(level) {
  const l = String(level || '').trim().toLowerCase();
  return (l === 'none' || l === 'medium' || l === 'high') ? l : 'medium';
}

/**
 * Compress an email body according to the job's compression level. Output size
 * is a strict ladder: none >= medium >= high.
 *   none   - raw body, untouched (largest)
 *   medium - HTML/entity cleanup + collapse whitespace + collapse over-long
 *            URLs (> MAX_URL_LENGTH) to [link]; keeps quoted replies and short
 *            URLs; 2000-char/email cap
 *   high   - everything medium does, PLUS strips quoted replies/signatures and
 *            collapses ALL URLs to [link], with a tighter cap (smallest)
 * @param {string} body - Raw body text
 * @param {string} level - normalized level ('none' | 'medium' | 'high')
 * @param {number} perEmailCap - Max chars (0 = no cap)
 * @returns {string}
 */
function compressBody_(body, level, perEmailCap) {
  body = body || '';

  if (level === 'none') {
    return body.trim();
  }

  if (level === 'high') {
    // Drop quoted history/signatures (needs line structure), then collapse
    // long tracking/unsubscribe URLs to a placeholder.
    body = stripQuotedText_(body);
    body = body.replace(/https?:\/\/\S+/g, '[link]');
  }

  // HTML/entity cleanup (medium + high). Some senders stuff HTML markup, MSO
  // conditional comments, and zero-width preheader padding into the text/plain
  // part, which getPlainBody() returns verbatim. Strip it BEFORE the char cap
  // so the budget is spent on real content, not markup noise.
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');             // comments incl. <!--[if mso]>
  body = body.replace(/<[^>]+>/g, ' ');                      // HTML tags
  body = body.replace(/&(zwnj|zwj|nbsp);/gi, ' ');           // common padding entities
  body = body.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ''); // zero-width chars
  body = body.replace(/\u034F/g, '');                     // combining grapheme joiner

  // Collapse over-long URLs to [link] so giant tracking/UTM links don't eat the
  // char budget. Short URLs (product/calendar links) are kept. No-op for 'high'
  // (it already collapsed every URL above).
  body = body.replace(/https?:\/\/\S+/g, function(url) {
    return url.length > MAX_URL_LENGTH ? '[link]' : url;
  });

  // Both medium and high collapse whitespace.
  body = body.replace(/\s+/g, ' ').trim();

  if (perEmailCap > 0 && body.length > perEmailCap) {
    body = body.substring(0, perEmailCap) + '... [trimmed]';
  }

  return body;
}

/**
 * Per-email character cap for a compression level. The levels form a strict
 * size ladder: none >= medium >= high (a higher level never produces a larger
 * body than a lower one).
 *   none   -> 0 (no cap, full bodies)
 *   medium -> fixed MAX_BODY_LENGTH per email
 *   high   -> total budget (LLM_CHAR_BUDGET) divided across the batch, but
 *             never more than medium's cap and never below MIN_BODY_CHARS
 * @param {string} level - normalized level
 * @param {number} count - number of emails in the batch
 * @returns {number}
 */
function perEmailCap_(level, count) {
  if (level === 'medium') {
    return MAX_BODY_LENGTH;
  }
  if (level === 'high') {
    // Divide the batch budget across emails, but clamp to [MIN_BODY_CHARS,
    // MAX_BODY_LENGTH] so 'high' is always <= 'medium' per email (small batches
    // used to make the budget/count value exceed medium's fixed cap).
    var budgetShare = Math.floor(LLM_CHAR_BUDGET / Math.max(1, count));
    return Math.max(MIN_BODY_CHARS, Math.min(MAX_BODY_LENGTH, budgetShare));
  }
  return 0;
}

/**
 * Structured, compression-aware email records for a webhook payload.
 * @param {Array<Object>} emails - Array of email objects (raw body)
 * @param {string} compression - Per-job compression level
 * @returns {Array<Object>} [{ id, threadId, from, to, date, subject, body }]
 */
function compressedEmails(emails, compression) {
  const level = normalizeCompression_(compression);
  const cap = perEmailCap_(level, (emails || []).length);
  return (emails || []).map((e) => ({
    id: e.id,
    threadId: e.threadId,
    from: e.from,
    to: e.to,
    date: e.date,
    subject: e.subject,
    body: compressBody_(e.body, level, cap)
  }));
}

/**
 * Format emails into a text block for LLM processing.
 * @param {Array<Object>} emails - Array of email objects
 * @param {string} compression - Per-job compression level ('none'|'medium'|'high')
 * @returns {string} Formatted text
 */
function formatEmailsForLLM(emails, compression) {
  if (!emails || emails.length === 0) {
    return 'No emails to process.';
  }

  const level = normalizeCompression_(compression);
  const perEmailCap = perEmailCap_(level, emails.length);

  const formatted = emails.map((email, index) => {
    const body = compressBody_(email.body, level, perEmailCap);

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
