/**
 * LLMProvider.gs - Factory for LLM providers
 *
 * Provides a pluggable architecture for different LLM backends.
 * Currently supports:
 * - Anthropic Claude (default) - claude-sonnet-4, claude-haiku-3.5, etc.
 * - Google Gemini - gemini-2.0-flash
 * - Ollama - self-hosted / proxied models (e.g. qwen3:8b)
 *
 * To add a new provider:
 * 1. Create YourProvider.gs with a createYourProvider(apiKey) function
 * 2. Return an object with analyze(prompt, content) method
 * 3. Register in LLMFactory.create() switch statement
 *
 * @fileoverview LLM provider factory for email analysis
 */

/**
 * Factory to create LLM provider instances
 */
var LLMFactory = {
  /**
   * Create an LLM provider instance
   * @param {string} providerName - Name of the provider (e.g., "anthropic", "gemini")
   * @param {Object} settings - Global settings containing API keys
   * @returns {Object} LLM provider instance with analyze() method
   */
  create: function(providerName, settings) {
    switch (providerName.toLowerCase()) {
      case 'anthropic':
        var model = settings.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
        return createAnthropicProvider(settings.ANTHROPIC_API_KEY, model);
      case 'gemini':
        return createGeminiProvider(settings.GEMINI_API_KEY);
      case 'ollama':
        return createOllamaProvider(settings.OLLAMA_URL, settings.OLLAMA_API_KEY, settings.OLLAMA_MODEL, settings.OLLAMA_AUTH_HEADER);
      default:
        throw new Error('Unknown LLM provider: ' + providerName + '. Available: anthropic, gemini, ollama');
    }
  }
};
