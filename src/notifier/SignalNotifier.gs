/**
 * SignalNotifier.gs - Custom Signal-backed chat notifier
 *
 * Sends notifications through a self-hosted Signal wrapper endpoint that
 * accepts a JSON body of { recipient, message }, e.g.
 * https://your-host/send.
 *
 * The auth header name is deployment specific and defaults to 'X-Api-Key'.
 * Signal messages are plain text, so title and body are flattened into a
 * single text message (no cards).
 */

/**
 * Create a Signal notifier instance
 * @param {string} url - Base URL or full /send endpoint
 *                        (e.g. 'https://your-host' or
 *                        'https://your-host/send')
 * @param {string} apiKey - Value sent in the auth header (optional if the
 *                           endpoint requires no auth)
 * @param {string} recipient - Recipient(s) to message. Comma-separated for
 *                             multiple (e.g. '+15551234567,+15559876543')
 * @param {string} authHeader - Name of the auth header to send the key in
 *                              (deployment specific, defaults to 'X-Api-Key')
 * @returns {Object} Notifier with send() and sendError() methods
 */
function createSignalNotifier(url, apiKey, recipient, authHeader) {
  if (!url) {
    throw new Error('SIGNAL_URL is required');
  }
  if (!recipient) {
    throw new Error('SIGNAL_RECIPIENT is required');
  }

  var endpoint = normalizeSignalUrl_(url);
  var headerName = (authHeader && String(authHeader).trim()) || 'X-Api-Key';
  var recipients = String(recipient).split(',').map(function(r) {
    return r.trim();
  }).filter(function(r) {
    return r.length > 0;
  });

  return {
    /**
     * Send a notification via Signal
     * @param {string} title - Notification title
     * @param {string} message - Notification body
     * @returns {boolean} Success status (true only if all recipients succeed)
     */
    send: function(title, message) {
      return sendSignalMessage_(endpoint, apiKey, headerName, recipients,
        buildSignalText_(title, message, false));
    },

    /**
     * Send an error notification via Signal
     * @param {string} title - Error context
     * @param {string} error - Error message
     * @returns {boolean} Success status (true only if all recipients succeed)
     */
    sendError: function(title, error) {
      return sendSignalMessage_(endpoint, apiKey, headerName, recipients,
        buildSignalText_('Error: ' + title, error, true));
    }
  };
}

/**
 * Normalize a Signal URL to a full /send endpoint.
 * Accepts either a base host or a URL that already includes the path.
 * @param {string} url - Configured SIGNAL_URL
 * @returns {string} Full endpoint URL
 */
function normalizeSignalUrl_(url) {
  var trimmed = String(url).trim().replace(/\/+$/, '');

  if (/\/send$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed + '/send';
}

/**
 * Build a plain-text Signal message from a title and body.
 * @param {string} title - Message title
 * @param {string} content - Message content
 * @param {boolean} isError - Whether this is an error notification
 * @returns {string} Flattened text message
 */
function buildSignalText_(title, content, isError) {
  var maxLength = 4000;
  if (content && content.length > maxLength) {
    content = content.substring(0, maxLength - 50) + '\n\n... [truncated]';
  }

  var icon = isError ? '⚠️' : '📧';
  // Signal renders **text** as bold; make the title stand out from the body.
  return icon + ' **' + title + '**\n\n' + (content || '');
}

/**
 * Post a message to the Signal endpoint for each recipient.
 * @param {string} endpoint - Full /send endpoint URL
 * @param {string} apiKey - Auth key (may be empty)
 * @param {string} headerName - Auth header name
 * @param {Array<string>} recipients - Recipients to message
 * @param {string} text - Message text
 * @returns {boolean} True only if every recipient send succeeds
 */
function sendSignalMessage_(endpoint, apiKey, headerName, recipients, text) {
  var headers = {};
  if (apiKey) {
    headers[headerName] = apiKey;
  }

  var allSucceeded = true;

  for (var i = 0; i < recipients.length; i++) {
    var options = {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({
        recipient: recipients[i],
        message: text
      }),
      muteHttpExceptions: true
    };

    try {
      var response = UrlFetchApp.fetch(endpoint, options);
      var responseCode = response.getResponseCode();

      if (responseCode < 200 || responseCode >= 300) {
        console.error('Signal endpoint error for ' + recipients[i] +
          ' (' + responseCode + '): ' + response.getContentText());
        allSucceeded = false;
      }
    } catch (e) {
      console.error('Failed to send Signal notification to ' + recipients[i] +
        ': ' + e.message);
      allSucceeded = false;
    }
  }

  return allSucceeded;
}

/**
 * Test function for Signal notifier
 */
function testSignalNotifier() {
  var settings = loadSettings();

  if (!settings.SIGNAL_URL) {
    console.log('SIGNAL_URL not configured in Settings sheet');
    return;
  }

  var notifier = NotifierFactory.create('signal', settings);

  var success = notifier.send(
    'Test Notification',
    'This is a test message from MailBot. If you see this, the Signal endpoint is working!'
  );

  console.log('Notification sent: ' + success);
}
