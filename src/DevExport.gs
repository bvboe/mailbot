/**
 * DevExport.gs - Developer utility to export recent inbox emails as JSON for
 * offline testing (e.g. the map-reduce summary experiments). Not used by the
 * bot at runtime - run it manually from the Apps Script editor, then download
 * the resulting file from Drive.
 *
 * The exported records use the SAME shape and extraction path as the bot
 * (getPlainBody), so the corpus faithfully represents what MailBot analyzes.
 *
 * PRIVACY: the output contains real email content. It lands in your own Drive;
 * download it, use it locally, and delete both copies when done.
 */

// How far back to export, in hours.
var EXPORT_WINDOW_HOURS = 24;

// Safety cap on threads scanned.
var EXPORT_MAX_THREADS = 300;

/**
 * Export inbox messages from the last EXPORT_WINDOW_HOURS to a JSON file in
 * Drive. Run from the editor, then open the logged URL to download.
 * @returns {string} The Drive file ID
 */
function runInboxExport() {
  var cutoff = new Date(Date.now() - EXPORT_WINDOW_HOURS * 60 * 60 * 1000);

  // newer_than:1d is day-granular, so we over-fetch then filter precisely by
  // each message's timestamp against the cutoff below.
  var query = 'in:inbox newer_than:2d';
  var threads = GmailApp.search(query, 0, EXPORT_MAX_THREADS);

  var out = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (msg.getDate() < cutoff) {
        continue; // older message inside a recently-active thread
      }
      out.push({
        id: msg.getId(),
        date: msg.getDate().toISOString(),
        from: msg.getFrom(),
        to: msg.getTo(),
        subject: msg.getSubject(),
        body: msg.getPlainBody() // raw plain text; trim in the test harness
      });
    }
  }

  var json = JSON.stringify(out, null, 2);
  var name = 'mailbot-inbox-export.json';
  var file = DriveApp.createFile(name, json, 'application/json');

  console.log('Exported ' + out.length + ' messages from the last ' +
    EXPORT_WINDOW_HOURS + 'h.');
  console.log('Download it here: ' + file.getUrl());
  console.log('File ID: ' + file.getId());

  return file.getId();
}
