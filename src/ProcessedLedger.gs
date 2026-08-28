/**
 * ProcessedLedger.gs - Idempotency ledger for processed Gmail message IDs.
 *
 * A job's cycle (analyze -> act -> notify -> unlabel) is NOT transactional. If
 * anything after a successful notify (LLM path) or webhook 2xx ack (webhook
 * path) fails - label removal errors, or the run dies - the trigger label
 * survives and the next run reprocesses the same message, producing a duplicate
 * notification/DM. The label alone cannot prevent this; a ledger can.
 *
 * We record each message ID the moment it has been durably handed off, and skip
 * any ID already present on the next run (removing its stale label). The ledger
 * is keyed per JOB, because one message can legitimately be processed by more
 * than one job (e.g. an "urgent" job and a "daily digest" job) - a global key
 * would let the first job suppress the second.
 *
 * Storage: UserProperties, one key per (job, message id), value = epoch ms.
 * Entries are pruned past LEDGER_TTL_MS - the ledger only needs to outlive the
 * gap until a failed run is retried, not remember forever - with a hard entry
 * cap guarding the properties store's size limit.
 */

// Key prefix so ledger entries are distinguishable from other UserProperties.
var LEDGER_PREFIX = 'seen::';

// How long an entry lives. Comfortably longer than any retry gap; anything
// older can't still be carrying a stale label from an in-flight run.
var LEDGER_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Hard cap on retained entries, guarding the ~500KB UserProperties budget.
var LEDGER_MAX_ENTRIES = 5000;

/**
 * Build the ledger key for a (job, message id) pair.
 * @param {string} jobName
 * @param {string} id - Gmail message ID
 * @returns {string}
 */
function ledgerKey_(jobName, id) {
  return LEDGER_PREFIX + jobName + '::' + id;
}

/**
 * Partition emails into those this job has already processed (present in the
 * ledger) and those still fresh. Reads the properties store once.
 * @param {string} jobName
 * @param {Array<Object>} emails - Email objects with an `id`
 * @returns {{ fresh: Array<Object>, already: Array<Object> }}
 */
function ledgerPartition_(jobName, emails) {
  var all = PropertiesService.getUserProperties().getProperties();
  var fresh = [];
  var already = [];

  for (var i = 0; i < emails.length; i++) {
    var id = emails[i].id;
    if (id && all[ledgerKey_(jobName, id)]) {
      already.push(emails[i]);
    } else {
      fresh.push(emails[i]);
    }
  }

  return { fresh: fresh, already: already };
}

/**
 * Record emails as processed by this job. Call AFTER a successful notify/ack
 * and BEFORE removing the label, so a later failure can't cause a re-notify.
 * @param {string} jobName
 * @param {Array<Object>} emails - Email objects with an `id`
 */
function ledgerMark_(jobName, emails) {
  if (!emails || emails.length === 0) {
    return;
  }

  var props = PropertiesService.getUserProperties();
  var now = Date.now();
  var stamp = String(now);
  var toSet = {};
  var any = false;

  for (var i = 0; i < emails.length; i++) {
    if (emails[i].id) {
      toSet[ledgerKey_(jobName, emails[i].id)] = stamp;
      any = true;
    }
  }

  if (!any) {
    return;
  }

  props.setProperties(toSet, false); // merge, don't wipe other properties
  ledgerPrune_(props, now);
}

/**
 * Drop expired entries (older than the TTL), then enforce the entry cap by
 * removing the oldest survivors if still over the limit.
 * @param {GoogleAppsScript.Properties.Properties} props - UserProperties store
 * @param {number} now - Current epoch ms
 */
function ledgerPrune_(props, now) {
  var all = props.getProperties();
  var cutoff = now - LEDGER_TTL_MS;
  var survivors = [];

  for (var key in all) {
    if (key.indexOf(LEDGER_PREFIX) !== 0) {
      continue;
    }
    var ts = parseInt(all[key], 10);
    if (isNaN(ts) || ts < cutoff) {
      props.deleteProperty(key);
    } else {
      survivors.push({ key: key, ts: ts });
    }
  }

  if (survivors.length > LEDGER_MAX_ENTRIES) {
    survivors.sort(function(a, b) { return a.ts - b.ts; }); // oldest first
    var excess = survivors.length - LEDGER_MAX_ENTRIES;
    for (var i = 0; i < excess; i++) {
      props.deleteProperty(survivors[i].key);
    }
  }
}
