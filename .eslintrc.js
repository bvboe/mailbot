module.exports = {
  'env': {
    'googleappsscript/googleappsscript': true
  },
  'extends': 'eslint:recommended',
  'plugins': [
    'googleappsscript'
  ],
  'parserOptions': {
    'ecmaVersion': 2020
  },
  'rules': {
    // Google Apps Script specific - allow entry points and factories
    'no-unused-vars': ['error', { 'varsIgnorePattern': '^(on|doGet|doPost|test|sidebar|create|delete|setup|install|run|health|initialize|remove|LLMFactory|NotifierFactory)' }],
    'no-redeclare': ['error', { 'builtinGlobals': false }],

    // Code style
    'indent': ['error', 2, { 'SwitchCase': 1 }],
    'linebreak-style': ['error', 'unix'],
    'quotes': ['error', 'single', { 'avoidEscape': true }],
    'semi': ['error', 'always'],

    // Best practices
    'eqeqeq': ['error', 'always'],
    'no-var': 'off', // GAS sometimes needs var for hoisting
    'prefer-const': 'error',

    // Relaxed rules for GAS compatibility
    'no-undef': 'off', // GAS globals like GmailApp, SpreadsheetApp
    'no-console': 'off' // console.log is valid in GAS
  },
  'globals': {
    // Google Apps Script services
    'GmailApp': 'readonly',
    'SpreadsheetApp': 'readonly',
    'DriveApp': 'readonly',
    'ScriptApp': 'readonly',
    'PropertiesService': 'readonly',
    'UrlFetchApp': 'readonly',
    'HtmlService': 'readonly',
    'Logger': 'readonly',
    'Utilities': 'readonly',
    'ContentService': 'readonly',
    'Session': 'readonly',

    // Project globals (functions defined in other files)
    'loadSettings': 'readonly',
    'loadJobs': 'readonly',
    'updateJobStatus': 'readonly',
    'getSheet_': 'readonly',
    'fetchEmailsWithLabel': 'readonly',
    'removeLabelFromEmails': 'readonly',
    'formatEmailsForLLM': 'readonly',
    'getOrCreateLabel': 'readonly',
    'getAllUserLabels': 'readonly',
    'starThread': 'readonly',
    'applyLabelsToThread': 'readonly',
    'LLMFactory': 'writable',
    'NotifierFactory': 'writable',
    'logExecution': 'readonly',
    'logError': 'readonly',
    'executeJob': 'readonly',
    'shouldJobRun': 'readonly',
    'showSidebar': 'readonly',
    'installSidebarMenu': 'readonly',
    'createConfigSheet': 'readonly',
    'createAnthropicProvider': 'readonly',
    'createGeminiProvider': 'readonly',
    'createOllamaProvider': 'readonly',
    'normalizeOllamaUrl_': 'readonly',
    'createGoogleChatNotifier': 'readonly',
    'createSignalNotifier': 'readonly',
    'normalizeSignalUrl_': 'readonly',
    'buildSystemPrompt_': 'readonly',
    'parseStructuredResponse_': 'readonly',
    'buildGeminiPrompt_': 'readonly',
    'parseGeminiStructuredResponse_': 'readonly',
    'processEmailActions_': 'readonly',
    'CONFIG_SHEET_ID': 'readonly',
    'SETTINGS_TAB': 'readonly',
    'JOBS_TAB': 'readonly',
    'EXECUTION_LOG_TAB': 'readonly',
    'JOBS_COLUMNS': 'readonly'
  }
};
