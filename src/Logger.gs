/**
 * Logger.gs - Execution logging to Google Sheets
 *
 * Logs job executions to the ExecutionLog tab for tracking and debugging.
 *
 * Columns:
 * - Timestamp: When the job ran
 * - JobName: Which job executed
 * - Status: 'success' or 'error'
 * - EmailsProcessed: Number of emails handled
 * - Summary: LLM response summary (truncated to 1000 chars)
 * - Error: Error message if status is 'error'
 *
 * The log is automatically trimmed to keep only the last 1000 entries
 * to prevent the sheet from growing too large.
 *
 * @fileoverview Execution logging service for MailBot
 */

/**
 * Log a job execution to the ExecutionLog sheet
 * @param {string} jobName - Name of the job
 * @param {string} status - "success" or "error"
 * @param {number} emailsProcessed - Number of emails processed
 * @param {string} summary - Brief summary of what was done
 * @param {string} error - Error message if status is "error"
 */
function logExecution(jobName, status, emailsProcessed, summary, error) {
  try {
    const sheet = getSheet_(EXECUTION_LOG_TAB);
    const timestamp = new Date();

    // Append new row
    sheet.appendRow([
      timestamp,
      jobName,
      status,
      emailsProcessed,
      truncateString_(summary, 1000), // Limit summary length
      error || ''
    ]);

    // Optional: Trim old logs to prevent sheet from growing too large
    trimLogIfNeeded_(sheet, 1000); // Keep last 1000 entries
  } catch (e) {
    // Don't let logging failures break the main flow
    console.error('Failed to log execution:', e.message);
  }
}

/**
 * Log an error that occurred outside of job execution
 * @param {string} context - Where the error occurred
 * @param {Error|string} error - The error
 */
function logError(context, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logExecution(context, 'error', 0, '', errorMessage);
}

/**
 * Trim the log sheet if it exceeds maxRows
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} maxRows - Maximum rows to keep (excluding header)
 */
function trimLogIfNeeded_(sheet, maxRows) {
  const lastRow = sheet.getLastRow();
  const rowsToDelete = lastRow - maxRows - 1; // -1 for header

  if (rowsToDelete > 0) {
    // Delete oldest rows (row 2 is first data row)
    sheet.deleteRows(2, rowsToDelete);
  }
}

/**
 * Truncate a string to a maximum length
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
function truncateString_(str, maxLength) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Initialize the ExecutionLog sheet with headers if empty
 */
function initializeLogSheet() {
  const sheet = getSheet_(EXECUTION_LOG_TAB);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp',
      'JobName',
      'Status',
      'EmailsProcessed',
      'Summary',
      'Error'
    ]);

    // Format header row
    const headerRange = sheet.getRange(1, 1, 1, 6);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f3f3f3');
  }
}
