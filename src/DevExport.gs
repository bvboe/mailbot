/**
 * DevExport.gs - Developer utility to export recent inbox emails as JSON for
 * offline testing (e.g. the map-reduce summary experiments). Not used by the
 * bot at runtime - run it manually from the Apps Script editor, then download
 * the resulting file from Drive.
 *
 * The exported records use the SAME extraction path and compression pipeline
 * as the bot (bodyText_ + compressBody_), so the corpus faithfully represents
 * what MailBot would send a job at the chosen compression level.
 *
 * PRIVACY: the output contains real email content. It lands in your own Drive;
 * download it, use it locally, and delete both copies when done.
 */

// How far back to export, in hours.
var EXPORT_WINDOW_HOURS = 24;

// Safety cap on threads scanned.
var EXPORT_MAX_THREADS = 300;

// Default compression applied to exported bodies: 'none' | 'medium' | 'high'.
// Overridden by the argument to runInboxExport(). 'none' = raw bodies.
var EXPORT_COMPRESSION = 'none';

/**
 * Export inbox messages from the last EXPORT_WINDOW_HOURS to a JSON file in
 * Drive. Run from the editor (uses EXPORT_COMPRESSION), or call with a level.
 * @param {string} [compression] - 'none' | 'medium' | 'high' (default: EXPORT_COMPRESSION)
 * @returns {string} The Drive file ID
 */
function runInboxExport(compression) {
  var level = normalizeCompression_(compression || EXPORT_COMPRESSION);
  var cutoff = new Date(Date.now() - EXPORT_WINDOW_HOURS * 60 * 60 * 1000);

  // Gmail's newer_than is day-granular, so search a window derived from
  // EXPORT_WINDOW_HOURS (rounded up, +1 day buffer) then filter precisely by
  // each message's timestamp against the cutoff below.
  var queryDays = Math.ceil(EXPORT_WINDOW_HOURS / 24) + 1;
  var query = 'in:inbox newer_than:' + queryDays + 'd';
  var threads = GmailApp.search(query, 0, EXPORT_MAX_THREADS);

  // First pass: collect in-window messages with raw (bodyText_) bodies.
  var raw = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (msg.getDate() < cutoff) {
        continue; // older message inside a recently-active thread
      }
      raw.push({
        id: msg.getId(),
        threadId: threads[t].getId(),
        date: msg.getDate().toISOString(),
        from: msg.getFrom(),
        to: msg.getTo(),
        subject: msg.getSubject(),
        body: bodyText_(msg)
      });
    }
  }

  // Second pass: apply the chosen compression. For 'high' the per-email cap
  // depends on the batch size, so it's computed from the export count - the
  // same way a job would compress this many emails.
  var cap = perEmailCap_(level, raw.length);
  var out = raw.map(function(e) {
    return {
      id: e.id,
      threadId: e.threadId,
      date: e.date,
      from: e.from,
      to: e.to,
      subject: e.subject,
      body: compressBody_(e.body, level, cap)
    };
  });

  var json = JSON.stringify(out, null, 2);
  var name = 'mailbot-inbox-export.json';
  var file = DriveApp.createFile(name, json, 'application/json');

  console.log('Exported ' + out.length + ' messages from the last ' +
    EXPORT_WINDOW_HOURS + 'h at compression=' + level + '.');
  console.log('Download it here: ' + file.getUrl());
  console.log('File ID: ' + file.getId());

  return file.getId();
}
