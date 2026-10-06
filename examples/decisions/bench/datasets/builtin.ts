/**
 * Built-in triage set: 40 hand-written items, 10 in each of the four
 * workflow styles the public Typed Decisions dataset uses (invoice
 * reconciliation, agent triage, security alerts, customer escalation).
 * Every item asks one `choice`, one `score` and one `noul` question, and
 * every gold label is deliberately unambiguous: it is a smoke-test and a
 * regression set, not a substitute for the public datasets (see
 * `fetch-datasets.md`).
 *
 * @module
 */

import type { IRDecisionQuestion } from '@johnhenry/aimatey-types';
import type { BenchItem, GoldValue } from '../types.js';

type Questions = Record<string, IRDecisionQuestion>;
type Row = readonly [id: string, state: string, a: GoldValue, b: GoldValue, c: GoldValue];

function build(workflow: string, questions: Questions, rows: readonly Row[]): BenchItem[] {
  const [q1, q2, q3] = Object.keys(questions) as [string, string, string];
  return rows.map(([id, state, a, b, c]) => ({
    id: `${workflow}-${id}`,
    workflow,
    state,
    questions,
    gold: { [q1]: a, [q2]: b, [q3]: c },
  }));
}

// ---------------------------------------------------------------------------
// Invoice reconciliation
// ---------------------------------------------------------------------------

const INVOICE: Questions = {
  match: {
    type: 'choice',
    instructions: 'How does this invoice compare with the purchase order and payment history?',
    criteria: {
      exact_match: 'Vendor and amount agree with a purchase order and nothing else is wrong',
      amount_mismatch: 'A purchase order exists but the invoiced amount differs from it',
      duplicate: 'The same invoice was already paid or is already queued for payment',
      missing_po: 'No purchase order exists or is referenced for this invoice',
    },
  },
  exposure: {
    type: 'score',
    instructions: 'How much money is at risk if this invoice is paid exactly as submitted?',
    criteria: ['none', 'minor (under $500)', 'major ($500 or more)'],
  },
  hold: {
    type: 'noul',
    instructions:
      'Should this invoice be held for manual review by a finance manager instead of being paid automatically?',
  },
};

const INVOICE_ITEMS = build('invoice-reconciliation', INVOICE, [
  ['01', 'Invoice INV-1001: $1,200.00 from Acme Supplies. PO-7781 authorizes $1,200.00 from Acme Supplies. Goods receipt confirms delivery.', 'exact_match', 0, false],
  ['02', 'Invoice INV-1002: $2,450.00 from Globex. PO-7790 authorizes $2,000.00 from Globex. Goods receipt confirms delivery.', 'amount_mismatch', 2, true],
  ['03', 'Invoice INV-1003: $310.00 from Initech. This invoice number was already paid on 2026-09-02 for the same amount against PO-7802.', 'duplicate', 1, true],
  ['04', 'Invoice INV-1004: $89.00 from Hooli Cloud. No purchase order number is referenced and no PO exists for Hooli Cloud.', 'missing_po', 1, true],
  ['05', 'Invoice INV-1005: $5,000.00 from Umbrella Corp. PO-7815 authorizes $5,000.00 from Umbrella Corp. Goods receipt confirms delivery.', 'exact_match', 0, false],
  ['06', 'Invoice INV-1006: $18,900.00 from Stark Industries. PO-7820 authorizes $9,450.00 from Stark Industries.', 'amount_mismatch', 2, true],
  ['07', 'Invoice INV-1007: $640.00 from Wayne Logistics. PO-7833 authorizes $640.00 from Wayne Logistics. Goods receipt confirms delivery.', 'exact_match', 0, false],
  ['08', 'Invoice INV-1008: $75.00 from Pied Piper. An invoice with the same number, vendor and amount was submitted yesterday and is already queued for payment.', 'duplicate', 1, true],
  ['09', 'Invoice INV-1009: $12,300.00 from Soylent Corp. The purchase order field is blank and there is no matching PO on file.', 'missing_po', 2, true],
  ['10', 'Invoice INV-1010: $430.00 from Cyberdyne. PO-7850 authorizes $430.00 from Cyberdyne. Goods receipt confirms delivery.', 'exact_match', 0, false],
]);

// ---------------------------------------------------------------------------
// Agent triage
// ---------------------------------------------------------------------------

const AGENT: Questions = {
  action: {
    type: 'choice',
    instructions: 'What should happen with the agent step described below?',
    criteria: {
      proceed: 'The step is safe and correct: let the agent continue',
      retry: 'The step failed for a transient reason: run it again',
      ask_human: 'The step is ambiguous or needs a decision or credentials only a person can provide',
      abort: 'The step would cause serious irreversible harm and must not happen',
    },
  },
  risk: {
    type: 'score',
    instructions: 'How risky is the agent\'s next step (side effects, reversibility)?',
    criteria: ['low', 'medium', 'high'],
  },
  destructive: {
    type: 'noul',
    instructions: 'Would the next step irreversibly delete or destroy data?',
  },
};

const AGENT_ITEMS = build('agent-triage', AGENT, [
  ['01', 'Agent step: ran `npm test`; 214 tests passed, 0 failed. Next planned step: commit the changes to a feature branch.', 'proceed', 0, false],
  ['02', 'Agent step: an HTTP request to the payments API returned 503 Service Unavailable. This is the first failure. Next planned step: call the same endpoint again.', 'retry', 0, false],
  ['03', 'Agent step: planned command is `rm -rf /var/lib/postgresql/data` to free disk space on the production database host.', 'abort', 2, true],
  ['04', 'Agent step: the task says "deploy to production" but two deploy targets exist (prod-us and prod-eu) and the task does not say which one to use.', 'ask_human', 1, false],
  ['05', 'Agent step: wrote the summary to ./report.md as requested. Next planned step: print the file path to the user.', 'proceed', 0, false],
  ['06', 'Agent step: `git push` failed with "authentication failed". The agent has no credentials for this remote and no way to obtain them.', 'ask_human', 0, false],
  ['07', 'Agent step: planned SQL is `DROP TABLE customers;` to resolve a failing migration, and no backup has been taken.', 'abort', 2, true],
  ['08', 'Agent step: fetching a web page timed out after 10 seconds because of a brief network blip. Next planned step: fetch it again once.', 'retry', 0, false],
  ['09', 'Agent step: planned command is `ls -la ./src` to inspect the project layout.', 'proceed', 0, false],
  ['10', 'Agent step: planned SQL is `DELETE FROM orders;` with no WHERE clause against the live orders database, but the task only asked to delete one test order.', 'abort', 2, true],
]);

// ---------------------------------------------------------------------------
// Security alerts
// ---------------------------------------------------------------------------

const SECURITY: Questions = {
  category: {
    type: 'choice',
    instructions: 'What kind of event is this security alert?',
    criteria: {
      phishing: 'A message trying to trick a person into revealing credentials, money or codes',
      malware: 'Malicious software running or detected on a machine',
      brute_force: 'Repeated automated attempts to guess credentials',
      benign: 'Normal, expected activity',
    },
  },
  severity: {
    type: 'score',
    instructions: 'How severe is this alert?',
    criteria: ['low', 'medium', 'high', 'critical'],
  },
  page: {
    type: 'noul',
    instructions: 'Should the on-call security analyst be paged immediately?',
  },
};

const SECURITY_ITEMS = build('security-alerts', SECURITY, [
  ['01', 'Email to finance: "Your mailbox is full, verify your password at http://mail-secure-login.example-support.top within 24h." The sender domain was registered 2 days ago. No one has clicked the link.', 'phishing', 1, false],
  ['02', '412 failed SSH logins for user root from 203.0.113.9 in 3 minutes, followed by one successful login from the same address.', 'brute_force', 3, true],
  ['03', 'EDR: unsigned binary svchost32.exe launched from %TEMP%, encrypted 1,800 files in 60 seconds and dropped README_RESTORE.txt.', 'malware', 3, true],
  ['04', 'The scheduled nightly backup job on db-04 completed in 42 minutes with exit code 0.', 'benign', 0, false],
  ['05', 'Two failed logins for user mchen from the office VPN, followed by a successful login a few seconds later.', 'benign', 0, false],
  ['06', 'A user reported this text: "CEO here, urgent: buy 5 gift cards and send me the codes, do not call." It came from a free webmail address. The user did not reply.', 'phishing', 1, false],
  ['07', 'EDR: PowerShell spawned by a Word macro downloaded a payload from a known command-and-control domain. The host is a domain controller.', 'malware', 3, true],
  ['08', 'Antivirus quarantined an adware installer on a single kiosk laptop. No outbound connections were observed.', 'malware', 0, false],
  ['09', '5,000 failed logins across 900 accounts from one IP in 10 minutes. All were blocked by rate limiting and there were no successful logins.', 'brute_force', 1, false],
  ['10', 'The security team\'s scheduled vulnerability scan finished and produced the weekly report with 3 medium findings.', 'benign', 0, false],
]);

// ---------------------------------------------------------------------------
// Customer escalation
// ---------------------------------------------------------------------------

const CUSTOMER: Questions = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this customer message?',
    criteria: {
      billing: 'Charges, refunds, invoices, payment problems',
      technical: 'Bugs, crashes, outages, broken features',
      account: 'Login, profile, settings, users and permissions',
      general: 'Feedback, questions about the product, anything else',
    },
  },
  sentiment: {
    type: 'score',
    instructions: 'How upset is the customer?',
    criteria: ['calm', 'frustrated', 'furious'],
  },
  churn: {
    type: 'noul',
    instructions: 'Is the customer threatening to cancel or switch to a competitor?',
  },
};

const CUSTOMER_ITEMS = build('customer-escalation', CUSTOMER, [
  ['01', 'Hi, I was charged twice for March. Could you refund the duplicate? Thanks.', 'billing', 0, false],
  ['02', 'This is the THIRD time your app crashed during export. I am cancelling my subscription today and moving to a competitor!', 'technical', 2, true],
  ['03', 'How do I change the email address on my profile? I cannot find the setting.', 'account', 0, false],
  ['04', 'I still have not received my refund after two weeks of emails. This is unacceptable and I am done with your service.', 'billing', 2, true],
  ['05', 'The login page keeps saying my password is wrong even after I reset it. Annoying, I have a meeting in 10 minutes.', 'account', 1, false],
  ['06', 'Just wanted to say thanks, the new dashboard is great. Any plans for a dark mode?', 'general', 0, false],
  ['07', 'The sync has been failing for a week and support has not fixed it. If this is not resolved by Friday, we will switch providers.', 'technical', 1, true],
  ['08', 'Can you send me last year\'s invoices for tax purposes? A PDF is fine.', 'billing', 0, false],
  ['09', 'I would like to invite two more teammates and give them admin access. How do I do that?', 'account', 0, false],
  ['10', 'Your outage cost my business a full day of sales and nobody has even replied to me. I am furious. Expect my cancellation request this afternoon.', 'technical', 2, true],
]);

/** All built-in items, interleaved by workflow so `--limit N` samples every style. */
export const BUILTIN_ITEMS: readonly BenchItem[] = (() => {
  const lists = [INVOICE_ITEMS, AGENT_ITEMS, SECURITY_ITEMS, CUSTOMER_ITEMS];
  const out: BenchItem[] = [];
  for (let i = 0; i < 10; i++) {
    for (const list of lists) {
      out.push(list[i]!);
    }
  }
  return out;
})();
