/**
 * GoogleChatNotifier.gs - Google Chat webhook implementation
 */

/**
 * Create a Google Chat notifier instance
 * @param {string} webhookUrl - Google Chat webhook URL
 * @returns {Object} Notifier with send() and sendError() methods
 */
function createGoogleChatNotifier(webhookUrl) {
  if (!webhookUrl) {
    throw new Error('GOOGLE_CHAT_WEBHOOK_URL is required');
  }

  return {
    /**
     * Send a notification to Google Chat
     * @param {string} title - Notification title
     * @param {string} message - Notification body
     * @returns {boolean} Success status
     */
    send: function(title, message) {
      var card = buildChatCard_(title, message, false);
      return postToWebhook_(webhookUrl, card);
    },

    /**
     * Send an error notification to Google Chat
     * @param {string} title - Error context
     * @param {string} error - Error message
     * @returns {boolean} Success status
     */
    sendError: function(title, error) {
      var card = buildChatCard_('⚠️ Error: ' + title, error, true);
      return postToWebhook_(webhookUrl, card);
    }
  };
}

/**
 * Build a Google Chat text message
 * @param {string} title - Message title
 * @param {string} content - Message content
 * @param {boolean} isError - Whether this is an error notification
 * @returns {Object} Message payload
 */
function buildChatCard_(title, content, isError) {
  // Truncate content if too long (Chat has limits)
  var maxLength = 4000;
  if (content && content.length > maxLength) {
    content = content.substring(0, maxLength - 50) + '\n\n... [truncated]';
  }

  var icon = isError ? '⚠️' : '📧';
  var separator = '─'.repeat(30);
  var text = icon + ' *' + title + '*\n' + separator + '\n\n' + content;

  return {
    text: text
  };
}

/**
 * Post a message to the webhook
 * @param {string} webhookUrl - Webhook URL
 * @param {Object} payload - Message payload
 * @returns {boolean} Success status
 */
function postToWebhook_(webhookUrl, payload) {
  try {
    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(webhookUrl, options);
    var responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      console.error('Google Chat webhook error (' + responseCode + '): ' + response.getContentText());
      return false;
    }

    return true;
  } catch (e) {
    console.error('Failed to send Google Chat notification: ' + e.message);
    return false;
  }
}

/**
 * Test function for Google Chat notifier
 */
function testGoogleChatNotifier() {
  var settings = loadSettings();

  if (!settings.GOOGLE_CHAT_WEBHOOK_URL) {
    console.log('GOOGLE_CHAT_WEBHOOK_URL not configured in Settings sheet');
    return;
  }

  var notifier = NotifierFactory.create('googlechat', settings);

  var success = notifier.send(
    'Test Notification',
    'This is a test message from MailBot. If you see this, the webhook is working!'
  );

  console.log('Notification sent: ' + success);
}
