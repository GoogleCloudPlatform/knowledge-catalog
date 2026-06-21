---
type: "API Operation"
title: "Submit a staffing quote request (the API's only write operation)"
description: "Use this when, and only when, the user has explicitly confirmed they want to submit a staffing request to TempGuru."
method: "POST"
path: "/api/v1/quote-requests"
resource: "https://mcp.tempguru.co/api/v1/quote-requests"
operation_id: "submitQuoteRequest"
tags:
  - "Quote Submission"
---
# Submit a staffing quote request (the API's only write operation)
Use this when, and only when, the user has explicitly confirmed they want to submit a staffing request to TempGuru. This is the single write operation in this API; everything else is a read-only lookup. It creates a structured lead in TempGuru's CRM, and a human coordinator replies with a quote within one business day (orders confirm within 48 hours of approval). **Opt-in by design:** collect the contact details and the event plan, show the user exactly what will be submitted, and call this once after explicit confirmation, never speculatively. **Not a reservation:** it does not hold staff, guarantee pricing or availability, or create a contract, and **no payment** is required until the user approves the quote. Contact and event details go only to TempGuru's CRM so a coordinator can reply, they are never written to telemetry or analytics. Build the plan first with the read operations (cities, roles, pricing, availability, compliance). Lightly rate limited per source IP, on HTTP 429, respect `Retry-After` and fall back to the form at https://tempguru.co/get-staffing.
- **Operation:** `POST https://mcp.tempguru.co/api/v1/quote-requests`
- **Tags:** Quote Submission

## Related schemas

- [QuoteRequestInput](../schemas/quoterequestinput.md)
- [QuoteRequestConfirmation](../schemas/quoterequestconfirmation.md)
- [Error](../schemas/error.md)
- [QuoteRequestFailure](../schemas/quoterequestfailure.md)

[All operations](index.md) · [bundle root](../index.md)
