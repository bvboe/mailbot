/**
 * AnthropicProvider.gs - Anthropic Claude LLM implementation
 */

/**
 * Create an Anthropic provider instance
 * @param {string} apiKey - Anthropic API key
 * @param {string} model - Model to use (e.g., 'claude-sonnet-4-20250514', 'claude-haiku-3-5-20241022')
 * @returns {Object} Provider with analyze() method
 */
function createAnthropicProvider(apiKey, model) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  var baseUrl = 'https://api.anthropic.com/v1/messages';
  var modelId = model || 'claude-sonnet-4-20250514';
  var maxRetries = 3;
  var retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

  return {
    /**
     * Analyze content using Anthropic Claude
     * @param {string} prompt - The analysis prompt from job config
     * @param {string} content - Formatted email content
     * @returns {Object} { response: string, isImportant: boolean }
     */
    analyze: function(prompt, content) {
      var systemPrompt = 'You are an email analysis assistant. Analyze emails and provide summaries.\n\n' +
        'FORMAT: Use Google Chat formatting:\n' +
        '- *bold* for emphasis and headings\n' +
        '- _italic_ for email subjects or names\n' +
        '- Bullet points for lists\n' +
        '- Keep it scannable and concise\n\n' +
        'IMPORTANT: At the very end of your response, on a new line, include exactly one of these markers:\n' +
        '- [IMPORTANT: YES] if there are urgent or important items that need attention\n' +
        '- [IMPORTANT: NO] if this is routine information only';

      var userMessage = 'INSTRUCTIONS:\n' + prompt + '\n\n' +
        'EMAILS TO ANALYZE:\n' + content + '\n\n' +
        'Please provide your analysis:';

      var requestBody = {
        model: modelId,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userMessage
        }]
      };

      var options = {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      };

      var lastError;

      for (var attempt = 0; attempt < maxRetries; attempt++) {
        var response = UrlFetchApp.fetch(baseUrl, options);
        var responseCode = response.getResponseCode();
        var responseText = response.getContentText();

        // Success
        if (responseCode === 200) {
          var result = JSON.parse(responseText);

          if (!result.content || result.content.length === 0) {
            throw new Error('Anthropic returned no content');
          }

          var text = result.content[0].text;
          return parseAnthropicResponse_(text);
        }

        // Retry on transient errors (5xx, 429 rate limit)
        if (responseCode >= 500 || responseCode === 429) {
          lastError = new Error('Anthropic API error (' + responseCode + '): ' + responseText);
          console.log('Attempt ' + (attempt + 1) + ' failed with ' + responseCode + ', retrying...');

          if (attempt < maxRetries - 1) {
            Utilities.sleep(retryDelays[attempt]);
          }
          continue;
        }

        // Non-retryable error (4xx except 429)
        throw new Error('Anthropic API error (' + responseCode + '): ' + responseText);
      }

      // All retries exhausted
      throw lastError;
    }
  };
}

/**
 * Parse the LLM response to extract summary and importance flag
 * @param {string} text - Raw LLM response
 * @returns {Object} { response: string, isImportant: boolean }
 */
function parseAnthropicResponse_(text) {
  // Check for importance marker
  var isImportant = text.indexOf('[IMPORTANT: YES]') !== -1;

  // Remove the marker from the response
  var cleanedResponse = text
    .replace(/\[IMPORTANT: (YES|NO)\]/g, '')
    .trim();

  return {
    response: cleanedResponse,
    isImportant: isImportant
  };
}

/**
 * Test function for Anthropic provider
 */
function testAnthropicProvider() {
  var settings = loadSettings();

  if (!settings.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not configured in Settings sheet');
    return;
  }

  var provider = LLMFactory.create('anthropic', settings);

  var testContent = '--- Email 1 ---\n' +
    'From: boss@company.com\n' +
    'To: me@company.com\n' +
    'Date: 2024-01-15\n' +
    'Subject: Urgent: Project deadline moved\n\n' +
    'The project deadline has been moved up to Friday. Please prioritize.\n';

  var result = provider.analyze(
    'Summarize these emails and flag any urgent items.',
    testContent
  );

  console.log('Response: ' + result.response);
  console.log('Is Important: ' + result.isImportant);
}
