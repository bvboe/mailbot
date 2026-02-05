/**
 * Notifier.gs - Factory for notification providers
 *
 * Provides a pluggable architecture for different notification backends.
 * Currently supports:
 * - Google Chat webhooks (default)
 *
 * To add a new notifier:
 * 1. Create YourNotifier.gs with a createYourNotifier(settings) function
 * 2. Return an object with send(title, message) and sendError(title, error) methods
 * 3. Register in NotifierFactory.create() switch statement
 *
 * @fileoverview Notification provider factory for sending alerts and summaries
 */

/**
 * Factory to create notifier instances
 */
var NotifierFactory = {
  /**
   * Create a notifier instance
   * @param {string} notifierName - Name of the notifier (e.g., "googlechat")
   * @param {Object} settings - Global settings containing webhook URLs
   * @returns {Object} Notifier instance with send() and sendError() methods
   */
  create: function(notifierName, settings) {
    switch (notifierName.toLowerCase()) {
      case 'googlechat':
        return createGoogleChatNotifier(settings.GOOGLE_CHAT_WEBHOOK_URL);
      default:
        throw new Error('Unknown notifier: ' + notifierName + '. Available: googlechat');
    }
  }
};
