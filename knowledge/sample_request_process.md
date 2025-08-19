Sample Request Process (Assistant-driven)



Instruction for Assistant: the following information is a mix of process and technical specifications.  They are to be consumed as training materials but the details are not to be shared in customer conversations unless it forms part of your necessary tasks.


0) Scope \& Goal

Handle “sample request” conversations end-to-end: capture details, check policy/eligibility, generate the request artifacts (email/packing slip/message), route for approval when needed, and track status through fulfillment—using the vector store as the primary knowledge source.

1. Intake \& Triage (in chat)

Trigger: user mentions “sample”, “try”, “send me a sample”, etc.

Assistant asks for:

Product/variant, quantity

Recipient (name, company), shipping address, phone/email

Reason/purpose (sales prospect, influencer, QA, warranty)

Deadline/urgency, special handling

Any budget/cost center (if internal)

Outputs:

An intake summary the user can confirm (“Got it: 2 × Lip Balm – Peach to ACME, ship to… by Fri.”).

A structured payload in memory: { product, qty, recipient, address, purpose, deadline, notes }.

2. Eligibility \& Policy Check (RAG)

How: Use file\_search over the vector store to retrieve:

Sample policy, limits (per product / per customer / per period)

Shipping rules, country restrictions, cost rules, approval thresholds

Any SKU-specific notes (e.g., “no free samples for X”)

Assistant behavior:

If policy is clear → proceed.

If ambiguous or over threshold → mark “Needs approval” and move to Route.

Outputs: decision { allowed: true|false|needs\_approval, reasons, cites }.

3. Record Creation (Samples DB)

System action (to build):

Create/Update a page in Notion ‘Samples’ DB with fields:
status (intake|approved|rejected|fulfilled), requester, product, qty, recipient, address, purpose, deadline, policy\_result, approval\_needed, approver, notes, created\_at, updated\_at.

Store a content hash so later edits can be diffed and re-synced.

(Today you only sync from Notion to the vector store. This step needs a small Notion write integration.)

4. Draft the Artifacts

Use knowledge + templates from the vector store to generate:

Email to warehouse/ops (or external vendor)

Customer confirmation (if the requester is external)

Packing slip (if you want a PDF, generate Markdown → PDF later)

Assistant shows drafts inline, with citations when policy text is quoted.

5. Route for Approval (when needed)

Rules:

Auto-approve under threshold/whitelisted cases.

Otherwise assign approver(s) and post a summary.

Implementation options (choose one):

MVP: Add a Notion select field approval → manager flips it to Approved/Rejected.

Nice: Slack/Email ping with Approve/Reject buttons (webhook).

Assistant behavior:

While pending, it gives the user the Notion link and current status.

6. Execute / Send

If approved:

Send the ops email (or create a task/ticket).
Missing today: an outbound email path (e.g., SendGrid) or a warehouse webhook.

Update Samples DB: status=approved → dispatched/fulfilled, add carrier, tracking, ship\_date.

7. Confirm \& Follow-up

Share confirmation + tracking with the requester.

Offer reminder (“Ping me if not delivered in 5 days?”).
You can use the in-process cron or external scheduler for follow-ups.

8. Closeout \& Analytics

When delivered, set status=fulfilled, write delivery date.

Log metrics: lead time, approval rate, denials, per-SKU sample count, geography.

Monthly report: top SKUs, reasons, costs.

9. Retrieval Grounding (what the model uses)

Always attach the vector store and call file\_search.

Prefer documents that match: policy, shipping, SKU data, templates.

Cite filenames (or titles) in answers when quoting policy.

10. Error Paths \& Escalation

Missing address or SKU → assistant asks for it.

Country restricted / out of policy → assistant explains and proposes alternatives (paid sample, digital kit).

API failure (Notion/email) → assistant reports the failure and keeps the draft available.

