# SIM Provisioning Runbook

**Owner:** Subscriber Provisioning **Audience:** Provisioning engineers and OSS operators

This runbook covers preparing a SIM and subscriber so a device can attach to the network and use data.

## What we provision

Two things make a subscriber usable: their identity on the SIM, and the data profile that lets their device reach services.

### IMSI

Every SIM is provisioned with an **IMSI (International Mobile Subscriber Identity)** — the globally unique subscriber identifier the network authenticates against. The IMSI is written to the SIM during personalization and registered in the subscriber database (HSS/HLR). Without a valid, registered IMSI, the device cannot authenticate or attach. The IMSI is the anchor that everything else about the subscriber hangs off.

### APN

The subscriber's data profile includes one or more **APNs (Access Point Names)**. The APN determines which packet data gateway — and therefore which network and policy set — a data session uses. A typical profile contains an internet APN for general data and may include a separate IMS APN used for VoLTE signaling. Provisioning the wrong APN is a common cause of "attached but no data" tickets: the subscriber authenticates fine (IMSI is good) but their sessions route to the wrong or a non-existent gateway.

## Procedure

1. Personalize the SIM with the IMSI and security keys.
2. Register the IMSI in the subscriber database with the correct service plan.
3. Apply the data profile, including the correct APN(s) for the plan.
4. Test: confirm attach (validates IMSI) and a data session on each APN.

## Common faults

- **Attach fails** → IMSI not registered or key mismatch.
- **Attaches, no data** → APN missing or misconfigured.
