# Postmortem: Metro Region Dropped-Calls Incident

**Status:** Final **Owner:** Network Operations **Date:** Most recent record on VoLTE QoS targets — supersedes the standing QoS Policy figure where they conflict.

## Summary

Over a two-week window, subscribers in the metro region experienced elevated VoLTE call drops and audible clipping. Investigation found that the standing latency target for the conversational-voice class was too loose for our actual network conditions, allowing calls to degrade before any alarm fired.

## Background

**VoLTE (Voice over LTE)** carries voice as packets and depends on the conversational-voice **QoS** class. The standing **QoS Policy** sets a one-way packet **latency budget of 100 ms** for that class. Monitoring alarmed only when latency exceeded that budget.

## What happened

In the affected cells, one-way latency frequently sat in the 80–100 ms band — *within* the 100 ms policy budget, so no alarm — yet call quality was already degrading and drops were climbing. The 100 ms target, inherited from an older network generation, did not reflect the tighter budget our current VoLTE codec and jitter profile actually need.

## Root cause

The VoLTE latency target was too high. At 100 ms the policy tolerated latency that in practice produced clipping and drops, and the alarm threshold tied to it fired too late to act.

## Corrective action

- **Effective immediately, the VoLTE one-way latency target is tightened to 80 ms.** This is the current target for the conversational-voice class carrying VoLTE and replaces the 100 ms figure in the QoS Policy. Calls must be kept under 80 ms one-way latency.
- Re-tune monitoring to alarm at 80 ms, with a warning at 70 ms.
- Architecture to fold the 80 ms target into the next QoS Policy revision.

## Follow-ups

1. Update the QoS Policy to 80 ms.
2. Review other real-time class budgets for the same legacy-inheritance issue.
