/**
 * WebhookProcessor.gs - Per-job webhook override.
 *
 * When a job has a WEBHOOK_URL, MailBot POSTs the batch to it INSTEAD of
 * calling the configured LLM. This is a fire-and-forget model: we send the
 * emails + job context, expect a fast 2xx ack, and let the webhook do the
 * heavy processing (and its own notification) asynchronously.
 *
 * - Success = 2xx. If the response body contains an analysis
 *   ({ summary, isImportant, emails }), MailBot uses it (notify/label/star);
 *   otherwise (bare ack) MailBot does nothing further and just removes the
 *   processing label.
 * - Transient failures (5xx / 429 / network) are retried with backoff, matching
 *   the LLM providers. Other 4xx throw immediately.
 * - Auth: WEBHOOK_API_KEY sent in WEBHOOK_AUTH_HEADER (default X-Api-Key).
 */

/**
 * POST a job's email batch to its webhook.
 * @param {Object} job - Job config (must include webhookUrl)
 * @param {Array<Object>} emails - The (already batched) emails to send
 * @param {Object} settings - Global settings (for auth)
 * @returns {Object} { ok: true, analysis: Object|null }
 * @throws on non-2xx after retries, or a network error
 */
function sendJobToWebhook_(job, emails, settings) {
  var url = job.webhookUrl;
  var apiKey = settings.WEBHOOK_API_KEY || '';
  var headerName = (settings.WEBHOOK_AUTH_HEADER && String(settings.WEBHOOK_AUTH_HEADER).trim()) ||
    'X-Api-Key';

  var payload = {
    job: {
      name: job.jobName,
      prompt: job.prompt,
      label: job.label,
      autoLabel: job.autoLabel,
      autoStar: job.autoStar,
      notifyCondition: job.notifyCondition,
      compression: job.compression
    },
    // Structured, compression-aware records so the webhook can map-reduce.
    emails: compressedEmails(emails, job.compression)
  };

  var headers = {};
  if (apiKey) {
    headers[headerName] = apiKey;
  }

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var maxRetries = 3;
  var retryDelays = [1000, 2000, 4000]; // Match the LLM providers' backoff.
  var lastError;

  for (var attempt = 0; attempt < maxRetries; attempt++) {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    var text = response.getContentText();

    // Success (any 2xx). The body is optional.
    if (code >= 200 && code < 300) {
      if (text && text.trim()) {
        try {
          return { ok: true, analysis: parseWebhookAnalysis_(text) };
        } catch (e) {
          // Body present but not JSON we understand -> treat as a bare ack.
          console.log('Webhook returned a non-analysis body; treating as ack.');
          return { ok: true, analysis: null };
        }
      }
      return { ok: true, analysis: null };
    }

    // Retry on transient errors.
    if (code >= 500 || code === 429) {
      lastError = new Error('Webhook error (' + code + '): ' + text);
      console.log('Webhook attempt ' + (attempt + 1) + ' failed with ' + code + ', retrying...');
      if (attempt < maxRetries - 1) {
        Utilities.sleep(retryDelays[attempt]);
      }
      continue;
    }

    // Non-retryable (4xx other than 429).
    throw new Error('Webhook error (' + code + '): ' + text);
  }

  throw lastError;
}

/**
 * Parse an optional analysis object from a webhook 2xx body.
 * @param {string} text - Response body
 * @returns {Object|null} Normalized { summary, isImportant, emails } if the
 *   body is analysis-shaped, else null (a bare ack). Throws on invalid JSON.
 */
function parseWebhookAnalysis_(text) {
  var obj = JSON.parse(text); // Throws on invalid JSON -> caller treats as ack.

  // Only treat as an analysis if it looks like one; anything else (e.g.
  // {"status":"accepted"}) is a bare ack.
  if (!obj || (typeof obj.summary !== 'string' && !Array.isArray(obj.emails))) {
    return null;
  }

  return {
    summary: obj.summary || '',
    isImportant: obj.isImportant === true,
    emails: Array.isArray(obj.emails) ? obj.emails.map(function(e, i) {
      return {
        index: (e && typeof e.index === 'number') ? e.index : i,
        star: !!(e && e.star === true),
        addLabels: (e && Array.isArray(e.addLabels)) ? e.addLabels : []
      };
    }) : []
  };
}
