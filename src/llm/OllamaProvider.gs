/**
 * OllamaProvider.gs - Ollama (self-hosted / proxied) LLM implementation
 *
 * Talks to an Ollama-compatible /api/generate endpoint. Supports a custom
 * authentication header for setups placed behind an auth proxy, e.g.
 * https://your-host/api/generate. The header name is deployment
 * specific and defaults to 'X-Api-Key'.
 *
 * Reuses buildSystemPrompt_() and parseStructuredResponse_() from
 * AnthropicProvider.gs since Ollama's /api/generate accepts a `system` field
 * and can be forced to emit JSON via `format: "json"`.
 *
 * Returns structured JSON response with:
 * - summary: Text summary for notifications
 * - isImportant: Boolean flag for conditional notifications
 * - emails: Per-email actions (star, labels)
 */

/**
 * Create an Ollama provider instance
 * @param {string} url - Base URL or full /api/generate endpoint
 *                        (e.g. 'https://your-host' or
 *                        'https://your-host/api/generate')
 * @param {string} apiKey - Value sent in the auth header (optional if the
 *                           endpoint requires no auth)
 * @param {string} model - Model to use (e.g. 'qwen3:8b')
 * @param {string} authHeader - Name of the auth header to send the key in
 *                              (deployment specific, defaults to 'X-Api-Key')
 * @param {number|string} numCtx - Context window size (num_ctx). Larger values
 *                                 fit more/longer emails but use more memory on
 *                                 the endpoint. Defaults to 8192.
 * @returns {Object} Provider with analyze() method
 */
function createOllamaProvider(url, apiKey, model, authHeader, numCtx) {
  if (!url) {
    throw new Error('OLLAMA_URL is required');
  }
  if (!model) {
    throw new Error('OLLAMA_MODEL is required');
  }

  var endpoint = normalizeOllamaUrl_(url);
  var headerName = (authHeader && String(authHeader).trim()) || 'X-Api-Key';
  var contextWindow = parseInt(numCtx, 10) > 0 ? parseInt(numCtx, 10) : 8192;
  var maxRetries = 3;
  var retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

  return {
    /**
     * Analyze content using an Ollama endpoint
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
        model: model,
        system: systemPrompt,
        prompt: userMessage,
        stream: false,
        // Pass a real JSON Schema (not just 'json') so Ollama constrains the
        // output to our structure. Plain 'json' only guarantees valid syntax,
        // which lets smaller models emit a schema instead of an instance.
        format: buildOllamaResponseSchema_(enableLabeling, enableStarring),
        options: {
          temperature: 0.3,
          // num_ctx is the shared input+output budget; num_predict caps output
          // and comes out of that budget. Larger inboxes need a larger num_ctx.
          num_ctx: contextWindow,
          num_predict: 4096,
          // Discourage repetition-loop degeneration (small models can get
          // stuck re-listing emails). repeat_last_n widens the look-back so
          // long-range repeats (whole-list loops) are penalized too.
          repeat_penalty: 1.3,
          repeat_last_n: 512
        }
      };

      var headers = {};
      if (apiKey) {
        headers[headerName] = apiKey;
      }

      var fetchOptions = {
        method: 'post',
        contentType: 'application/json',
        headers: headers,
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      };

      var lastError;

      for (var attempt = 0; attempt < maxRetries; attempt++) {
        var response = UrlFetchApp.fetch(endpoint, fetchOptions);
        var responseCode = response.getResponseCode();
        var responseText = response.getContentText();

        // Success
        if (responseCode === 200) {
          var result = JSON.parse(responseText);

          if (!result.response) {
            throw new Error('Ollama returned no response text');
          }

          // Reuse the Anthropic parser - the response is our JSON payload
          return parseStructuredResponse_(result.response);
        }

        // Retry on transient errors (5xx, 429 rate limit)
        if (responseCode >= 500 || responseCode === 429) {
          lastError = new Error('Ollama API error (' + responseCode + '): ' + responseText);
          console.log('Attempt ' + (attempt + 1) + ' failed with ' + responseCode + ', retrying...');

          if (attempt < maxRetries - 1) {
            Utilities.sleep(retryDelays[attempt]);
          }
          continue;
        }

        // Non-retryable error (4xx except 429)
        throw new Error('Ollama API error (' + responseCode + '): ' + responseText);
      }

      // All retries exhausted
      throw lastError;
    }
  };
}

/**
 * Normalize an Ollama URL to a full /api/generate endpoint.
 * Accepts either a base host or a URL that already includes the path.
 * @param {string} url - Configured OLLAMA_URL
 * @returns {string} Full endpoint URL
 */
function normalizeOllamaUrl_(url) {
  var trimmed = String(url).trim().replace(/\/+$/, '');

  if (/\/api\/generate$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed + '/api/generate';
}

/**
 * Build the JSON Schema Ollama should constrain its response to. This mirrors
 * exactly what parseStructuredResponse_() expects, so the model returns a
 * conforming instance rather than valid-but-arbitrary JSON.
 * @param {boolean} enableLabeling - Include the addLabels field
 * @param {boolean} enableStarring - Include the star field
 * @returns {Object} JSON Schema object
 */
function buildOllamaResponseSchema_(enableLabeling, enableStarring) {
  var emailProps = {
    index: { type: 'integer' }
  };
  var emailRequired = ['index'];

  if (enableStarring) {
    emailProps.star = { type: 'boolean' };
    emailRequired.push('star');
  }

  if (enableLabeling) {
    emailProps.addLabels = {
      type: 'array',
      items: { type: 'string' }
    };
    emailRequired.push('addLabels');
  }

  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      isImportant: { type: 'boolean' },
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: emailProps,
          required: emailRequired
        }
      }
    },
    required: ['summary', 'isImportant', 'emails']
  };
}

/**
 * Test function for Ollama provider
 */
function testOllamaProvider() {
  var settings = loadSettings();

  if (!settings.OLLAMA_URL) {
    console.log('OLLAMA_URL not configured in Settings sheet');
    return;
  }

  var provider = LLMFactory.create('ollama', settings);

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
