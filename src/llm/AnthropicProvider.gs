/**
 * AnthropicProvider.gs - Anthropic Claude LLM implementation
 *
 * Returns structured JSON response with:
 * - summary: Text summary for notifications
 * - isImportant: Boolean flag for conditional notifications
 * - emails: Per-email actions (star, labels)
 */

/**
 * Create an Anthropic provider instance
 * @param {string} apiKey - Anthropic API key
 * @param {string} model - Model to use (e.g., 'claude-sonnet-4-20250514')
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

      var systemPrompt = buildSystemPrompt_(existingLabels, enableLabeling, enableStarring);

      var userMessage = 'INSTRUCTIONS:\n' + prompt + '\n\n' +
        'EMAILS TO ANALYZE:\n' + content + '\n\n' +
        'Provide your analysis as JSON:';

      var requestBody = {
        model: modelId,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userMessage
        }]
      };

      var fetchOptions = {
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
        var response = UrlFetchApp.fetch(baseUrl, fetchOptions);
        var responseCode = response.getResponseCode();
        var responseText = response.getContentText();

        // Success
        if (responseCode === 200) {
          var result = JSON.parse(responseText);

          if (!result.content || result.content.length === 0) {
            throw new Error('Anthropic returned no content');
          }

          var text = result.content[0].text;
          return parseStructuredResponse_(text);
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
 * Build the system prompt for structured JSON response
 * @param {Array<string>} existingLabels - List of existing Gmail labels
 * @param {boolean} enableLabeling - Whether to include labeling instructions
 * @param {boolean} enableStarring - Whether to include starring instructions
 * @returns {string} System prompt
 */
function buildSystemPrompt_(existingLabels, enableLabeling, enableStarring) {
  var prompt = 'You are an email analysis assistant. Analyze emails and respond with structured JSON.\n\n';

  prompt += 'RESPONSE FORMAT: You must respond with valid JSON only. No other text before or after.\n\n';

  prompt += 'JSON STRUCTURE:\n';
  prompt += '{\n';
  prompt += '  "summary": "Brief summary for notification (use Google Chat formatting: *bold*, _italic_, bullet points)",\n';
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
  prompt += '- emails: One entry per email, using 0-based index matching "Email 1" = index 0, "Email 2" = index 1, etc.\n';

  if (enableStarring) {
    prompt += '- star: Set to true for emails that are urgent, important, or require follow-up.\n';
  }

  if (enableLabeling) {
    prompt += '- addLabels: Array of labels to apply. Can be empty [].\n\n';

    prompt += 'LABELING GUIDELINES:\n';
    prompt += '- Prefer existing labels when they fit.\n';
    prompt += '- Use hierarchical labels like "Customers/CompanyName" for customer emails.\n';
    prompt += '- Use "Internal" for internal company emails.\n';
    prompt += '- Create new labels for new customers or categories as needed.\n';
    prompt += '- Label names should be concise and consistent.\n\n';

    if (existingLabels && existingLabels.length > 0) {
      // Filter to show relevant labels (exclude system labels)
      var relevantLabels = existingLabels.filter(function(label) {
        return label.indexOf('INBOX') !== 0 &&
               label.indexOf('SPAM') !== 0 &&
               label.indexOf('TRASH') !== 0 &&
               label.indexOf('DRAFT') !== 0 &&
               label.indexOf('SENT') !== 0 &&
               label.indexOf('STARRED') !== 0 &&
               label.indexOf('UNREAD') !== 0;
      });

      if (relevantLabels.length > 0) {
        prompt += 'EXISTING LABELS (prefer these when applicable):\n';
        prompt += relevantLabels.slice(0, 50).join(', ') + '\n\n'; // Limit to 50 labels
      }
    }
  }

  prompt += 'IMPORTANT: Respond with valid JSON only. No markdown code blocks, no explanations.';

  return prompt;
}

/**
 * Parse the structured JSON response from the LLM
 * @param {string} text - Raw LLM response
 * @returns {Object} { summary: string, isImportant: boolean, emails: Array }
 */
function parseStructuredResponse_(text) {
  // Default response structure
  var defaultResponse = {
    summary: '',
    isImportant: false,
    emails: []
  };

  try {
    // Try to extract JSON from the response
    var jsonText = text.trim();

    // Remove markdown code blocks if present
    if (jsonText.indexOf('```json') === 0) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.indexOf('```') === 0) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    jsonText = jsonText.trim();

    // Parse JSON
    var parsed = JSON.parse(jsonText);

    // Validate and extract fields
    var result = {
      summary: parsed.summary || '',
      isImportant: parsed.isImportant === true,
      emails: []
    };

    // Process emails array
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
    console.error('Failed to parse LLM JSON response: ' + e.message);
    console.log('Raw response: ' + text.substring(0, 500));

    // Fallback: try to extract basic info from text
    defaultResponse.summary = text.replace(/```[\s\S]*?```/g, '').trim();
    defaultResponse.isImportant = text.toLowerCase().indexOf('urgent') !== -1 ||
                                   text.toLowerCase().indexOf('important') !== -1;

    return defaultResponse;
  }
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
    'The project deadline has been moved up to Friday. Please prioritize.\n\n' +
    '--- Email 2 ---\n' +
    'From: newsletter@marketing.com\n' +
    'To: me@company.com\n' +
    'Date: 2024-01-15\n' +
    'Subject: Weekly Newsletter\n\n' +
    'Check out our latest updates and promotions.\n';

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
