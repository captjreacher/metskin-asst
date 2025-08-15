# Chat Assistant Integration Spec (Campaign & Verification)

## 1) Scope & Actors
- **Chat Assistant (“Bot”)**: gathers customer info, initiates actions (verify email, request samples/products, run campaigns), tracks status.
- **App (Flask API + React UI)**: source of truth for contacts, verification, campaigns, and webhook config; orchestrates Make.com calls; receives webhooks.
- **Make.com**: executes verification and campaign scenarios; posts results back to the App.

---

## 2) Identity & Auth
- **Bot → App**: Bearer token in `Authorization` header.
- **App → Make.com**: Signed URL + optional HMAC header; include API key or scenario key in headers if required.
- **Make.com → App (webhooks)**: Verify with shared secret in header (e.g., `X-Signature`) + replay protection `X-Request-Timestamp`.

---

## 3) Frontend Routes (React)
- `/contacts` – list/search/edit contacts; select for verification/campaigns.
- `/verification` – select contacts; **Run Verification** button.
- `/campaigns` – create campaign; pick job/scenario; **Run Campaign**.
- `/settings` – configure outgoing webhook URLs, auth headers, field mappings.
- `/upload` – CSV/XLSX import of contacts.

---

## 4) Core Data Models (DB)
(See assistant message for detailed table structure.)

---

## 5) Backend API (Flask)
(Endpoints for contacts, verification, campaigns, settings, uploads.)

---

## 6) Outbound Payloads (App → Make.com)
(Example JSON bodies for verification trigger and campaign trigger.)

---

## 7) Inbound Payloads (Make.com → App)
(Example JSON bodies for verification results and campaign results.)

---

## 8) Chatbot–App API Contract
(How chatbot calls App endpoints for creating contacts, running verification, requesting products, running campaigns.)

---

## 9) Validation & Business Rules
(List of mandatory fields, preconditions, verification rules.)

---

## 10) Error Handling
(Standard JSON error format.)

---

## 11) Field Mapping (Make.com)
(Per webhook config, map App fields to Make fields.)

---

## 12) Sequence Diagrams
(Text diagrams for verification and campaign flows.)

---

## 13) Example Headers
(App → Make and Make → App headers.)

---

## 14) Logging & Observability
(Notes on correlation IDs, metrics, payload storage.)

---

## 15) Open Questions / Decisions
(Auth choice, secret rotation, contact-level campaign results, phone number collection policy.)

---

## Endpoint Quick Reference
- **Contacts**: `/api/contacts` (CRUD)
- **Verification**: `/api/verification/start`, `/api/verification/jobs/{job_id}`, `/api/verification-results`
- **Campaigns**: `/api/campaigns`, `/api/campaigns/run`, `/api/campaign-results`
- **Settings**: `/api/settings/webhooks` (CRUD)
- **Uploads**: `/api/upload`
