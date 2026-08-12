/**
 * GeminiProvider.gs - Google Gemini LLM implementation
 *
 * Returns structured JSON response with:
 * - summary: Text summary for notifications
 * - isImportant: Boolean flag for conditional notifications
 * - emails: Per-email actions (star, labels)
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
     * @param {Object} options - Additional options
     * @param {Array<string>} options.existingLabels - List of existing Gmail labels
     * @param {boolean} options.enableLabeling - Whether to include labeling suggestions
     * @param {boolean} options.enableStarring - Whether to include starring suggestions
     * @returns {Object} { summary: string, isImportant: boolean, emails: Array }
     */
    analyze: function(prompt, content, options) {
      options = options || {};
      var existingLabels = options.existingLabels || [];
      var enableLabeling = options.enableLabeling !== false;
      var enableStarring = options.enableStarring !== false;

      var fullPrompt = buildGeminiPrompt_(prompt, content, existingLabels, enableLabeling, enableStarring);

      var requestBody = {
        contents: [{
          parts: [{
            text: fullPrompt
          }]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048
        }
      };

      var fetchOptions = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      };

      var url = baseUrl + '?key=' + apiKey;
      var lastError;

      for (var attempt = 0; attempt < maxRetries; attempt++) {
        var response = UrlFetchApp.fetch(url, fetchOptions);
        var responseCode = response.getResponseCode();
        var responseText = response.getContentText();

        // Success
        if (responseCode === 200) {
          var result = JSON.parse(responseText);

          if (!result.candidates || result.candidates.length === 0) {
            throw new Error('Gemini returned no candidates');
          }

          var text = result.candidates[0].content.parts[0].text;
          return parseGeminiStructuredResponse_(text);
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
 * Build the full prompt with system instructions for Gemini
 * @param {string} userPrompt - The job-specific prompt
 * @param {string} content - Email content
 * @param {Array<string>} existingLabels - List of existing Gmail labels
 * @param {boolean} enableLabeling - Whether to include labeling instructions
 * @param {boolean} enableStarring - Whether to include starring instructions
 * @returns {string}
 */
function buildGeminiPrompt_(userPrompt, content, existingLabels, enableLabeling, enableStarring) {
  var prompt = 'You are an email analysis assistant. Analyze the following emails and respond with structured JSON.\n\n';

  prompt += 'RESPONSE FORMAT: You must respond with valid JSON only. No other text before or after.\n\n';

  prompt += 'JSON STRUCTURE:\n';
  prompt += '{\n';
  prompt += '  "summary": "Brief summary for notification",\n';
  prompt += '  "isImportant": true/false,\n';
  prompt += '  "emails": [\n';
  prompt += '    {\n';
  prompt += '      "index": 0,\n';

  if (enableStarring) {
    prompt += '      "star": true/false,\n';
  }

  if (enableLabeling) {
    prompt += '      "addLabels": ["Label1", "Label2"]\n';
  }

  prompt += '    }\n';
  prompt += '  ]\n';
  prompt += '}\n\n';

  prompt += 'FIELD GUIDELINES:\n';
  prompt += '- summary: Concise overview for notification. Group related emails under short *bold* headings, with brief bullet points beneath each heading (one bullet per email or theme). Keep it short and do NOT repeat any email, heading, or point more than once. This summary is shown directly to the user, so refer to each email by its sender and/or subject - NEVER by its position number ("Email 1", "Email 2") or index; those labels are internal only.\n';
  prompt += '- isImportant: Set to true if ANY email requires immediate attention.\n';
  prompt += '- emails: One entry per email, using 0-based index.\n';

  if (enableStarring) {
    prompt += '- star: Set to true for urgent or important emails.\n';
  }

  if (enableLabeling) {
    prompt += '- addLabels: Array of labels to apply. Can be empty [].\n';
    prompt += '- Use hierarchical labels like "Customers/CompanyName" for customer emails.\n';
    prompt += '- Use "Internal" for internal company emails.\n\n';

    if (existingLabels && existingLabels.length > 0) {
      var relevantLabels = existingLabels.filter(function(label) {
        return label.indexOf('INBOX') !== 0 &&
               label.indexOf('SPAM') !== 0 &&
               label.indexOf('TRASH') !== 0 &&
               label.indexOf('DRAFT') !== 0 &&
               label.indexOf('SENT') !== 0;
      });

      if (relevantLabels.length > 0) {
        prompt += 'EXISTING LABELS (prefer these):\n';
        prompt += relevantLabels.slice(0, 50).join(', ') + '\n\n';
      }
    }
  }

  prompt += 'INSTRUCTIONS:\n' + userPrompt + '\n\n';
  prompt += 'EMAILS TO ANALYZE:\n' + content + '\n\n';
  prompt += 'Respond with valid JSON only:';

  return prompt;
}

/**
 * Parse the structured JSON response from Gemini
 * @param {string} text - Raw LLM response
 * @returns {Object} { summary: string, isImportant: boolean, emails: Array }
 */
function parseGeminiStructuredResponse_(text) {
  var defaultResponse = {
    summary: '',
    isImportant: false,
    emails: []
  };

  try {
    var jsonText = text.trim();

    // Remove markdown code blocks if present
    if (jsonText.indexOf('```json') === 0) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.indexOf('```') === 0) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    jsonText = jsonText.trim();

    var parsed = JSON.parse(jsonText);

    var result = {
      summary: parsed.summary || '',
      isImportant: parsed.isImportant === true,
      emails: []
    };

    if (parsed.emails && Array.isArray(parsed.emails)) {
      for (var i = 0; i < parsed.emails.length; i++) {
        var email = parsed.emails[i];
        result.emails.push({
          index: typeof email.index === 'number' ? email.index : i,
          star: email.star === true,
          addLabels: Array.isArray(email.addLabels) ? email.addLabels : []
        });
      }
    }

    return result;
  } catch (e) {
    console.error('Failed to parse Gemini JSON response: ' + e.message);
    console.log('Raw response: ' + text.substring(0, 500));

    defaultResponse.summary = text.replace(/```[\s\S]*?```/g, '').trim();
    defaultResponse.isImportant = text.toLowerCase().indexOf('urgent') !== -1;

    return defaultResponse;
  }
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

  var existingLabels = getAllUserLabels();

  var result = provider.analyze(
    'Summarize these emails and flag any urgent items.',
    testContent,
    {
      existingLabels: existingLabels,
      enableLabeling: true,
      enableStarring: true
    }
  );

  console.log('Summary: ' + result.summary);
  console.log('Is Important: ' + result.isImportant);
  console.log('Emails: ' + JSON.stringify(result.emails, null, 2));
}
