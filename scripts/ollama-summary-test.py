#!/usr/bin/env python3
"""
ollama-summary-test.py - Realistic MailBot summary benchmark.

Sends a representative batch of 20 emails (mixed security alerts, LinkedIn,
GitHub, promotions, newsletters, threads-with-quotes) through the SAME request
shape MailBot uses against Ollama:
  - the same system prompt (summary-focused)
  - the same JSON-schema structured output
  - the same LIGHT trimming (quote/signature strip + URL->[link] only)

It optimizes for QUALITY + RELIABILITY, not speed. On a CPU-only host this can
take several minutes - that's expected; the point is to confirm the model
returns a complete, schema-valid summary of all 20 emails, and to measure how
long a single synchronous request takes (relevant to the Apps Script fetch
timeout).

Config via environment variables:
  OLLAMA_URL          base URL (default http://localhost:11434)
  OLLAMA_MODEL        model tag (default qwen3:8b)
  OLLAMA_NUM_CTX      context window (default 16384)
  OLLAMA_NUM_PREDICT  max output tokens (default 2048)
  OLLAMA_API_KEY      optional auth key
  OLLAMA_AUTH_HEADER  auth header name (default X-Api-Key)

Usage:
  python3 ollama-summary-test.py
"""

import json
import os
import re
import time
import urllib.request

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
BASE_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
ENDPOINT = BASE_URL if BASE_URL.endswith("/api/generate") else BASE_URL + "/api/generate"
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b")
NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "16384"))
NUM_PREDICT = int(os.environ.get("OLLAMA_NUM_PREDICT", "2048"))
API_KEY = os.environ.get("OLLAMA_API_KEY", "")
AUTH_HEADER = os.environ.get("OLLAMA_AUTH_HEADER", "X-Api-Key")

# TRIM mode:
#   "light" (default) - the real MailBot pipeline: quote/signature strip +
#                       URL->[link] + generous per-email budget (~5-6k tokens).
#   "off"             - raw bodies, whitespace-collapse only, no budget. Mimics
#                       the pre-trimming worst case we saw (~11-13k tokens).
TRIM = os.environ.get("TRIM", "light").lower()

# Light trimming only - we are going for quality, not aggressive compression.
LLM_CHAR_BUDGET = 60000   # generous: ~3000 chars/email for 20 -> bodies pass through
MIN_BODY_CHARS = 300

# --------------------------------------------------------------------------
# Realistic 20-email corpus (mixed types, some with quoted history / sigs / urls)
# --------------------------------------------------------------------------
EMAILS = [
    {"from": "no-reply@accounts.google.com", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 13:07:00 -0400",
     "subject": "Security alert: new app access to your account",
     "body": ("clasp - The Apps Script CLI was granted access to your Google "
              "Account bjornvb@gmail.com. If this was you, you don't need to do "
              "anything. If you don't recognize this activity, we'll help you "
              "secure your account. Check activity: "
              "https://accounts.google.com/AccountChooser?Email=bjornvb%40gmail.com&continue=https://myaccount.google.com/alert/nt/1786045730000\n\n"
              "You received this email to let you know about important changes "
              "to your Google Account and services. (c) 2026 Google LLC, 1600 "
              "Amphitheatre Parkway, Mountain View, CA 94043")},
    {"from": "no-reply@accounts.google.com", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 13:12:00 -0400",
     "subject": "Security alert: MailBot has access to your account",
     "body": ("MailBot was granted access to your Google Account "
              "bjornvb@gmail.com with permission to manage Gmail labels and send "
              "email on your behalf. If this was you, no action is needed. "
              "Review access: https://myaccount.google.com/permissions")},
    {"from": "no-reply@accounts.google.com", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 13:15:00 -0400",
     "subject": "Access confirmed for clasp",
     "body": ("This confirms that clasp - The Apps Script CLI now has access to "
              "your account. If this was you, you're all set and no further "
              "action is required. If you did not authorize this, review your "
              "account's third-party access and remove it: "
              "https://myaccount.google.com/permissions\n\n"
              "You can see security-related activity at any time on the Security "
              "Checkup page. You received this email to let you know about "
              "important changes to your Google Account and services. (c) 2026 "
              "Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043")},
    {"from": "no-reply@accounts.google.com", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 13:16:00 -0400",
     "subject": "Access confirmed for MailBot",
     "body": ("This confirms MailBot now has access to your account. No action "
              "is needed if this was you. The application was granted permission "
              "to read, compose, send, and permanently delete email from Gmail, "
              "and to manage your labels. You can review or revoke this access "
              "at https://myaccount.google.com/permissions at any time.\n\n"
              "If you don't recognize this activity, we recommend changing your "
              "password and running a Security Checkup. (c) 2026 Google LLC, "
              "1600 Amphitheatre Parkway, Mountain View, CA 94043")},
    {"from": "Fidelity Investments <insights@fidelity.com>", "to": "bjornvb@gmail.com",
     "date": "Tue, 05 Aug 2026 09:30:00 -0400",
     "subject": "Register now: Insights Live webinar, August 13",
     "body": ("Join our Insights Live webinar on August 13 at 2pm ET.\n\n"
              "In this session, our panel of retirement specialists will walk "
              "through strategies for managing rising health care costs in "
              "retirement, a topic that consistently ranks as the number one "
              "financial concern among pre-retirees. We'll cover how to estimate "
              "your lifetime health care spending, why a couple retiring today "
              "may need six figures set aside for medical expenses alone, and how "
              "inflation in medical services compounds over a multi-decade "
              "retirement.\n\n"
              "Agenda:\n"
              "1. Estimating health care costs across retirement phases\n"
              "2. Making the most of your Health Savings Account (HSA) - the "
              "triple tax advantage, investing the balance, and using it as a "
              "stealth retirement account\n"
              "3. Medicare enrollment timelines, Parts A/B/C/D explained, and the "
              "penalties for late enrollment\n"
              "4. Bridging coverage if you retire before 65\n"
              "5. Live Q&A with the panel\n\n"
              "Can't attend live? Register anyway and we'll send you the "
              "recording and the slide deck. Register: "
              "https://fidelity.com/webinars/insights-live-0813\n\n"
              "This material is provided for informational purposes only and "
              "should not be construed as investment, tax, or legal advice. "
              "Fidelity Brokerage Services LLC, Member NYSE, SIPC, 900 Salem "
              "Street, Smithfield, RI 02917. To stop receiving promotional "
              "emails, update your email preferences.")},
    {"from": "Riverside Animal Hospital <reminders@riversidevet.com>", "to": "bjornvb@gmail.com",
     "date": "Mon, 04 Aug 2026 16:45:00 -0400",
     "subject": "Sven is due for preventive treatments",
     "body": ("Hi Bjorn, our records show that Sven is due for annual vaccines "
              "and heartworm preventive. Please call to schedule an appointment "
              "within the next 30 days. You can also book online at "
              "https://riversidevet.com/book. Thank you for trusting us with "
              "Sven's care!\n\n-- \nRiverside Animal Hospital\n(555) 010-2020")},
    {"from": "LinkedIn <notifications@linkedin.com>", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 08:00:00 -0400",
     "subject": "Today's puzzle is ready",
     "body": ("Take a quick brain break - today's LinkedIn puzzle games are "
              "live. Play Pinpoint, Queens, and Crossclimb now: "
              "https://linkedin.com/games")},
    {"from": "LinkedIn <notifications@linkedin.com>", "to": "bjornvb@gmail.com",
     "date": "Tue, 05 Aug 2026 19:20:00 -0400",
     "subject": "Wayne Henderson, MBA accepted your invitation",
     "body": ("Wayne Henderson, MBA (Director of Engineering at Northwind) "
              "accepted your connection request. Say hi and start a "
              "conversation: https://linkedin.com/in/wayne-henderson")},
    {"from": "Double Good <fundraising@doublegood.com>", "to": "bjornvb@gmail.com",
     "date": "Mon, 04 Aug 2026 11:00:00 -0400",
     "subject": "Support the team's popcorn fundraiser!",
     "body": ("The Westside Robotics team is raising funds with a virtual "
              "popcorn sale. Every bag supports their trip to the regional "
              "competition. Shop and share: https://doublegood.com/s/westside")},
    {"from": "Rescue Me! <adopt@rescueme.org>", "to": "bjornvb@gmail.com",
     "date": "Sun, 03 Aug 2026 10:15:00 -0400",
     "subject": "Meet Biscuit - looking for a forever home",
     "body": ("Biscuit is a 2-year-old lab mix who loves walks and belly rubs. "
              "Our Rescue Me! campaign is matching adoption fees this month. "
              "Meet Biscuit and other adoptable pets: https://rescueme.org/biscuit")},
    {"from": "El Paso Mexican Restaurant <deals@elpasomex.com>", "to": "bjornvb@gmail.com",
     "date": "Fri, 01 Aug 2026 12:00:00 -0400",
     "subject": "Game day special: 20% off catering",
     "body": ("Football season is back! Get 20% off any catering order over $50 "
              "this weekend. Use code GAMEDAY at checkout. Order: "
              "https://elpasomex.com/order")},
    {"from": "GitHub <notifications@github.com>", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 07:42:00 -0400",
     "subject": "[bjornvb/mailbot] Run failed: CI",
     "body": ("The workflow 'CI' failed for commit d3b5b33 (\"Improved release "
              "process\") on branch main, pushed by bjornvb.\n\n"
              "Job: lint\nStep: Run eslint\nDuration: 34s\nRunner: ubuntu-latest\n\n"
              "Error output:\n"
              "  /home/runner/work/mailbot/src/GmailService.gs\n"
              "    32:10  error  'fetchEmailsWithLabel' is defined but never used\n"
              "   184:10  error  'formatEmailsForLLM' is defined but never used\n"
              "   217:10  error  'getOrCreateLabel' is defined but never used\n"
              "   244:10  error  'starThread' is defined but never used\n"
              "   271:10  error  'applyLabelsToThread' is defined but never used\n"
              "  5 problems (5 errors, 0 warnings)\n"
              "  Error: Process completed with exit code 1.\n\n"
              "These are cross-file false positives from linting Apps Script "
              "files individually. View the full run and logs: "
              "https://github.com/bjornvb/mailbot/actions/runs/1786001\n\n"
              "You are receiving this because you are watching this repository. "
              "Manage your notification settings or unsubscribe.")},
    {"from": "Best Buy <deals@emailinfo.bestbuy.com>", "to": "bjornvb@gmail.com",
     "date": "Tue, 05 Aug 2026 06:00:00 -0400",
     "subject": "Members-only: save on laptops and SSDs",
     "body": ("Your My Best Buy Plus perks are here - members-only savings "
              "through Sunday at midnight.\n\n"
              "Featured deals:\n"
              "- Save up to $200 on select 14\" and 16\" laptops with 16GB RAM\n"
              "- 20% off internal NVMe SSDs (1TB and 2TB)\n"
              "- $50 off select mechanical keyboards\n"
              "- Buy one, get one 40% off on select USB-C hubs and docks\n"
              "- Open-box laptops from $399, certified and warrantied\n\n"
              "Plus members get free 2-day shipping and an extended 60-day "
              "return window on most items. Not a member yet? Upgrade at "
              "checkout for $49.99/year and unlock exclusive pricing, early "
              "access to sales, and 24/7 tech support from the Geek Squad.\n\n"
              "Shop now: https://bestbuy.com/deals\n\n"
              "Prices and availability subject to change. While supplies last. "
              "See site for full terms. You are receiving this because you have "
              "a My Best Buy account. View this email in your browser. "
              "Unsubscribe or manage your email preferences. Best Buy, 7601 "
              "Penn Avenue South, Richfield, MN 55423.")},
    {"from": "Pizza Hut <offers@pizzahut.com>", "to": "bjornvb@gmail.com",
     "date": "Mon, 04 Aug 2026 17:00:00 -0400",
     "subject": "Large 3-topping for $9.99",
     "body": ("Tonight only - large 3-topping pizza for $9.99 with online orders. "
              "Order at https://pizzahut.com. Terms apply.")},
    {"from": "GitHub <notifications@github.com>", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 09:10:00 -0400",
     "subject": "[bjornvb/mailbot] Run failed: Release",
     "body": ("The workflow 'Release' failed for tag v0.2.0.\n\nJob: build\n"
              "Step: clasp push\nError: Invalid --project path: .clasp.json. "
              "File or directory does not exist.\n\nView run: "
              "https://github.com/bjornvb/mailbot/actions/runs/1786099")},
    {"from": "Madison Fuller <inmail@linkedin.com>", "to": "bjornvb@gmail.com",
     "date": "Tue, 05 Aug 2026 14:30:00 -0400",
     "subject": "InMail: Senior Platform Engineer opportunity",
     "body": ("Hi Bjorn,\n\nThanks for the reply! To share a bit more detail: "
              "the company is a Series B security startup (about 120 people, "
              "backed by two well-known funds) building developer tooling for "
              "software supply-chain security. The Senior Platform Engineer role "
              "is fully remote within the US and sits on the core platform team, "
              "owning the internal build and release infrastructure that every "
              "other engineering team depends on.\n\n"
              "What they're looking for: strong background in automation and "
              "internal tooling, comfort across CI/CD, some exposure to "
              "LLM-assisted developer workflows (a big plus given where they're "
              "headed), and the ability to work independently in a fast-moving "
              "environment. Compensation is $180-220k base plus meaningful "
              "early-stage equity, full health/dental/vision, and a home-office "
              "stipend.\n\n"
              "Given your background with Apps Script automation and LLM tooling, "
              "I really think this could be a fit. Would you be open to a 20-minute "
              "intro call this week? I have Thursday and Friday afternoon open.\n\n"
              "On Mon, Aug 4, 2026 at 3:00 PM Bjorn wrote:\n"
              "> Thanks for reaching out, I'm not actively looking but happy to "
              "hear details.\n"
              "> On Aug 4, Madison Fuller wrote:\n"
              ">> Hi Bjorn, I'm a technical recruiter and came across your "
              "profile...\n\n"
              "-- \nMadison Fuller | Talent Partner | Vector Search Partners\n"
              "Book time with me: [link]")},
    {"from": "Thai Basil Kitchen <hello@thaibasil.com>", "to": "bjornvb@gmail.com",
     "date": "Sat, 02 Aug 2026 18:00:00 -0400",
     "subject": "New lunch menu + free delivery this week",
     "body": ("We've refreshed our lunch menu with new curries and noodle bowls. "
              "Enjoy free delivery on orders over $25 all week. Menu: "
              "https://thaibasil.com/lunch")},
    {"from": "The Pragmatic Engineer <newsletter@pragmaticengineer.com>", "to": "bjornvb@gmail.com",
     "date": "Tue, 05 Aug 2026 05:00:00 -0400",
     "subject": "Issue #212: Running LLMs on the edge",
     "body": ("Welcome to this week's issue. We go deep on a topic several "
              "readers asked about: running language models on constrained, "
              "on-premise hardware instead of cloud APIs.\n\n"
              "In this issue:\n\n"
              "1) Lessons from the edge. Three engineering teams share what they "
              "learned deploying 7-8B parameter models on single-board computers "
              "and small servers. The recurring theme: memory, not compute, is "
              "usually the first wall you hit. KV cache grows linearly with "
              "context length, and on unified-memory devices it competes directly "
              "with model weights for the same pool.\n\n"
              "2) Quantization tradeoffs. We benchmark Q4, Q5, and Q8 quants of "
              "the same model on identical hardware. Q4 roughly halves memory "
              "versus Q8 with surprisingly small quality loss on summarization "
              "tasks, but code generation degrades more noticeably. The article "
              "includes throughput numbers for both GPU and CPU-only inference.\n\n"
              "3) Structured outputs in practice. A deep dive on constraining "
              "model output to a JSON schema. We show how schema-guided decoding "
              "eliminates the 'model returns prose instead of JSON' failure mode, "
              "and why small models especially benefit - they are far more likely "
              "to drift without a hard constraint.\n\n"
              "4) Context windows and cost. Longer context is not free even when "
              "it fits: prefill time scales with prompt length, and on CPU that "
              "prefill can dominate total latency. Trimming input aggressively is "
              "often a bigger win than a larger window.\n\n"
              "Read the full issue online: https://pragmaticengineer.com/212\n\n"
              "You're receiving this because you subscribed to The Pragmatic "
              "Engineer. Unsubscribe any time. Manage your subscription "
              "preferences.")},
    {"from": "Google Calendar <calendar-notification@google.com>", "to": "bjornvb@gmail.com",
     "date": "Wed, 06 Aug 2026 08:30:00 -0400",
     "subject": "Invitation: Q3 planning sync @ Thu Aug 7, 10:00am",
     "body": ("You have been invited to the following event.\n\n"
              "Title: Q3 planning sync\n"
              "When: Thursday, August 7, 2026, 10:00 - 11:00am (Eastern Time)\n"
              "Where: Google Meet (link below)\n"
              "Organizer: Priya Raman\n"
              "Guests: Priya Raman, Bjorn, Wayne Henderson, Dana Lee, "
              "Marco Ruiz (5 total)\n\n"
              "Agenda:\n"
              "1. Roadmap review - progress against Q2 commitments and what "
              "carries into Q3\n"
              "2. Staffing - open req for the platform team and contractor "
              "conversions\n"
              "3. On-call rotation - proposal to move to a follow-the-sun model "
              "and reduce weekend load\n"
              "4. Budget - infrastructure spend review, including the on-prem "
              "inference server evaluation\n"
              "5. Open floor\n\n"
              "Please come prepared with your team's top three priorities. "
              "Join with Google Meet: https://meet.google.com/abc-defg-hij\n"
              "Or dial in: (US) +1 555-000-1234 PIN: 123 456 789#\n\n"
              "RSVP: Yes / Maybe / No")},
    {"from": "Chase <no-reply@alerts.chase.com>", "to": "bjornvb@gmail.com",
     "date": "Mon, 04 Aug 2026 22:05:00 -0400",
     "subject": "Your July statement is ready",
     "body": ("Your July account statement is now available to view online.\n\n"
              "Account: Chase Total Checking (...4821)\n"
              "Statement period: Jul 1 - Jul 31, 2026\n"
              "Beginning balance: $4,210.55\n"
              "Deposits and additions: $6,120.00\n"
              "Withdrawals and payments: $5,489.32\n"
              "Ending balance: $4,841.23\n\n"
              "A few recent transactions:\n"
              "- Jul 28  Payroll deposit            +$3,060.00\n"
              "- Jul 27  Mortgage payment           -$1,842.10\n"
              "- Jul 25  Grocery - Whole Foods         -$156.44\n"
              "- Jul 22  Utility - electric            -$98.20\n\n"
              "Log in to review your full activity at https://chase.com. For "
              "your security, we will never ask for your password, PIN, or "
              "one-time code by email. If you notice anything unusual, contact "
              "us at the number on the back of your card. This is a service "
              "message regarding your account.")},
]


# --------------------------------------------------------------------------
# Append realistic HTML-mail bulk (long tracking URLs + CAN-SPAM footer) to
# every email. This is exactly the kind of content that inflated the raw prompt
# to ~11k tokens; light trimming collapses the URLs and keeps the footer text.
# --------------------------------------------------------------------------
def _track(seed):
    tok = (seed + "0123456789abcdef") * 12
    return ("https://click.mail.example.com/f/a/" + tok[:120]
            + "/redir?utm_source=email&utm_medium=notification&utm_campaign=" + seed)


def _footer():
    return (
        "\n\n-----------------\n"
        "You are receiving this email because you have an account with, or "
        "subscribed to updates from, this sender.\n"
        "Unsubscribe: " + _track("unsub") + "\n"
        "Manage email preferences: " + _track("prefs") + "\n"
        "View this message in your browser: " + _track("view") + "\n"
        "Connect with us: " + _track("fb") + " | " + _track("x") + "\n"
        "This message and any attachments are confidential and intended only "
        "for the addressee. If you received this in error, please delete it.\n"
        "(c) 2026. All rights reserved. 123 Example Ave, Suite 100, "
        "Somewhere, CA 90000.")


for _e in EMAILS:
    _e["body"] = _e["body"] + _footer()


# --------------------------------------------------------------------------
# Trimming (mirrors GmailService.gs - LIGHT settings)
# --------------------------------------------------------------------------
def strip_quoted(body):
    kept = []
    for line in body.splitlines():
        if re.match(r"^\s*On .+wrote:\s*$", line):
            break
        if re.match(r"^--\s*$", line):
            break
        if re.match(r"^\s*>", line):
            continue
        kept.append(line)
    return "\n".join(kept)


def clean_body(body):
    if TRIM == "off":
        # Worst-case: keep everything (long URLs, quotes), collapse whitespace.
        return re.sub(r"\s+", " ", body).strip()
    # Light (production) trimming.
    body = strip_quoted(body)
    body = re.sub(r"https?://\S+", "[link]", body)
    body = re.sub(r"\s+", " ", body).strip()
    return body


def format_emails(emails):
    # No per-email budget in worst-case mode; generous budget otherwise.
    per_email = 10 ** 9 if TRIM == "off" else max(MIN_BODY_CHARS, LLM_CHAR_BUDGET // len(emails))
    blocks = []
    for i, e in enumerate(emails):
        body = clean_body(e["body"])
        if len(body) > per_email:
            body = body[:per_email] + "... [trimmed]"
        blocks.append(
            "--- Email {n} ---\nFrom: {f}\nTo: {t}\nDate: {d}\nSubject: {s}\n\n{b}\n".format(
                n=i + 1, f=e["from"], t=e["to"], d=e["date"], s=e["subject"], b=body))
    return "\n".join(blocks)


# --------------------------------------------------------------------------
# Prompt + schema (mirrors buildSystemPrompt_ / buildOllamaResponseSchema_,
# summary-focused: labeling/starring OFF)
# --------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "You are an email analysis assistant. Analyze emails and respond with "
    "structured JSON.\n\n"
    "RESPONSE FORMAT: valid JSON only. No other text.\n\n"
    "JSON STRUCTURE:\n"
    '{\n  "summary": "Brief summary for notification (use *bold*, bullet points)",\n'
    '  "isImportant": true/false,\n  "emails": [ { "index": 0 } ]\n}\n\n'
    "FIELD GUIDELINES:\n"
    "- summary: Concise overview grouped by theme. Cover every email.\n"
    "- isImportant: true only if ANY email requires urgent action.\n"
    "- emails: one entry per email, 0-based index.\n\n"
    "IMPORTANT: valid JSON only, no markdown fences.")

JOB_PROMPT = ("Provide a brief summary of these emails grouped by category or "
              "sender. Include key information, action items, and any deadlines. "
              "Note anything urgent.")

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "isImportant": {"type": "boolean"},
        "emails": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"index": {"type": "integer"}},
                "required": ["index"],
            },
        },
    },
    "required": ["summary", "isImportant", "emails"],
}


# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------
def main():
    content = format_emails(EMAILS)
    user_message = ("INSTRUCTIONS:\n" + JOB_PROMPT + "\n\nEMAILS TO ANALYZE:\n"
                    + content + "\n\nProvide your analysis as JSON:")

    payload = json.dumps({
        "model": MODEL,
        "system": SYSTEM_PROMPT,
        "prompt": user_message,
        "stream": False,
        "think": False,
        "format": RESPONSE_SCHEMA,
        "options": {"temperature": 0.3, "num_ctx": NUM_CTX, "num_predict": NUM_PREDICT},
    }).encode()

    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers[AUTH_HEADER] = API_KEY

    print("=" * 64)
    print("MailBot summary benchmark")
    print("  endpoint :", ENDPOINT)
    print("  model    :", MODEL)
    print("  trim     :", TRIM, "(light = production, off = worst-case)")
    print("  num_ctx  :", NUM_CTX, " num_predict:", NUM_PREDICT)
    print("  emails   :", len(EMAILS), " prompt chars:", len(user_message))
    print("=" * 64)
    print("Sending request (CPU inference may take several minutes)...")

    req = urllib.request.Request(ENDPOINT, payload, headers)
    t0 = time.time()
    try:
        raw = urllib.request.urlopen(req).read().decode()
    except Exception as exc:  # noqa
        print("REQUEST FAILED:", exc)
        return
    wall = time.time() - t0
    r = json.loads(raw)

    def secs(ns):
        return (ns or 0) / 1e9

    pe, ped = r.get("prompt_eval_count", 0), secs(r.get("prompt_eval_duration"))
    ev, evd = r.get("eval_count", 0), secs(r.get("eval_duration"))
    resp_text = r.get("response", "")

    print("\n----- METRICS -----")
    print("prompt_tokens     :", pe, "(fits in num_ctx)" if pe < NUM_CTX else "*** EXCEEDS num_ctx ***")
    print("gen_tokens        :", ev)
    print("load_s            :", round(secs(r.get("load_duration")), 1))
    print("prompt_eval_s     :", round(ped, 1),
          "  ({} tok/s)".format(round(pe / ped, 1) if ped else "n/a"))
    print("gen_s             :", round(evd, 1),
          "  ({} tok/s)".format(round(ev / evd, 1) if evd else "n/a"))
    print("wall_s            :", round(wall, 1),
          "  ({} min)".format(round(wall / 60, 1)))
    print("done_reason       :", r.get("done_reason"))

    # ----- RELIABILITY CHECKS -----
    print("\n----- RELIABILITY -----")
    checks = []
    parsed = None
    try:
        parsed = json.loads(resp_text)
        checks.append((True, "response is valid JSON"))
    except Exception as exc:  # noqa
        checks.append((False, "response is valid JSON (parse error: %s)" % exc))

    if parsed is not None:
        checks.append((isinstance(parsed.get("summary"), str) and bool(parsed.get("summary")),
                       "summary is a non-empty string"))
        checks.append((isinstance(parsed.get("isImportant"), bool),
                       "isImportant is a boolean"))
        em = parsed.get("emails")
        checks.append((isinstance(em, list), "emails is an array"))
        if isinstance(em, list):
            idxs = sorted({e.get("index") for e in em if isinstance(e, dict)})
            covered = set(idxs) >= set(range(len(EMAILS)))
            checks.append((covered,
                           "all %d emails covered (got indices: %s)" % (len(EMAILS), idxs)))
    checks.append((r.get("done_reason") == "stop",
                   "output not truncated (done_reason == stop)"))
    checks.append((pe < NUM_CTX, "input not truncated (prompt_tokens < num_ctx)"))

    ok = 0
    for passed, label in checks:
        print(("  PASS " if passed else "  FAIL ") + label)
        ok += 1 if passed else 0
    print("  ---> %d/%d checks passed" % (ok, len(checks)))

    print("\n----- SUMMARY OUTPUT -----")
    if parsed and isinstance(parsed.get("summary"), str):
        print(parsed["summary"])
        print("\nisImportant:", parsed.get("isImportant"))
    else:
        print(resp_text[:2000])


if __name__ == "__main__":
    main()
