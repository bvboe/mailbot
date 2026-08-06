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

// Maximum body length to include in LLM context
const MAX_BODY_LENGTH = 2000;

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
        body: truncateBody_(message.getPlainBody()),
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
 * Truncate email body to stay within LLM context limits
 * @param {string} body - Full email body
 * @returns {string} Truncated body
 */
function truncateBody_(body) {
  if (!body) return '';

  // Clean up excessive whitespace
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

  const formatted = emails.map((email, index) => {
    return `--- Email ${index + 1} ---
From: ${email.from}
To: ${email.to}
Date: ${email.date}
Subject: ${email.subject}

${email.body}
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
  return labels.map(function(label) {
    return label.getName();
  });
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
