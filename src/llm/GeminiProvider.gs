/**
 * GeminiProvider.gs - Google Gemini LLM implementation
 */

/**
 * Create a Gemini provider instance
 * @param {string} apiKey - Gemini API key
 * @returns {Object} Provider with analyze() method
 */
function createGeminiProvider(apiKey) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required');
  }

  var baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
  var maxRetries = 3;
  var retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

  return {
    /**
     * Analyze content using Google Gemini
     * @param {string} prompt - The analysis prompt from job config
     * @param {string} content - Formatted email content
     * @returns {Object} { response: string, isImportant: boolean }
     */
    analyze: function(prompt, content) {
      var fullPrompt = buildGeminiPrompt_(prompt, content);

      var requestBody = {
        contents: [{
          parts: [{
            text: fullPrompt
          }]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024
        }
      };

      var options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      };

      var url = baseUrl + '?key=' + apiKey;
      var lastError;

      for (var attempt = 0; attempt < maxRetries; attempt++) {
        var response = UrlFetchApp.fetch(url, options);
        var responseCode = response.getResponseCode();
        var responseText = response.getContentText();

        // Success
        if (responseCode === 200) {
          var result = JSON.parse(responseText);

          if (!result.candidates || result.candidates.length === 0) {
            throw new Error('Gemini returned no candidates');
          }

          var text = result.candidates[0].content.parts[0].text;
          return parseGeminiResponse_(text);
        }

        // Retry on transient errors (5xx, 429 rate limit)
        if (responseCode >= 500 || responseCode === 429) {
          lastError = new Error('Gemini API error (' + responseCode + '): ' + responseText);
          console.log('Attempt ' + (attempt + 1) + ' failed with ' + responseCode + ', retrying...');

          if (attempt < maxRetries - 1) {
            Utilities.sleep(retryDelays[attempt]);
          }
          continue;
        }

        // Non-retryable error (4xx except 429)
        throw new Error('Gemini API error (' + responseCode + '): ' + responseText);
      }

      // All retries exhausted
      throw lastError;
    }
  };
}

/**
 * Build the full prompt with system instructions
 * @param {string} userPrompt - The job-specific prompt
 * @param {string} content - Email content
 * @returns {string}
 */
function buildGeminiPrompt_(userPrompt, content) {
  return 'You are an email analysis assistant. Analyze the following emails and provide a summary.\n\n' +
    'INSTRUCTIONS:\n' + userPrompt + '\n\n' +
    'IMPORTANT: At the very end of your response, on a new line, include exactly one of these markers:\n' +
    '- [IMPORTANT: YES] if there are urgent or important items that need attention\n' +
    '- [IMPORTANT: NO] if this is routine information only\n\n' +
    'EMAILS TO ANALYZE:\n' + content + '\n\n' +
    'Please provide your analysis:';
}

/**
 * Parse the LLM response to extract summary and importance flag
 * @param {string} text - Raw LLM response
 * @returns {Object} { response: string, isImportant: boolean }
 */
function parseGeminiResponse_(text) {
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
 * Test function for Gemini provider
 */
function testGeminiProvider() {
  var settings = loadSettings();

  if (!settings.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY not configured in Settings sheet');
    return;
  }

  var provider = LLMFactory.create('gemini', settings);

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
