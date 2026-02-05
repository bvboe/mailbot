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
 * Test function for Gmail operations
 */
function testGmailService() {
  // Test fetching (won't work without actual label)
  console.log('Testing Gmail service...');

  // List all labels
  const labels = GmailApp.getUserLabels();
  console.log('Available labels:', labels.map(l => l.getName()));

  console.log('Gmail service test complete');
}
