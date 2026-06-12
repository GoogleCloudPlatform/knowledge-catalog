# Quality of Service (QoS) Policy

**Owner:** Network Policy & Architecture **Status:** Standing policy (see Dropped-Calls Postmortem for any later revisions)

This policy defines how traffic classes are treated on our network and the targets each must meet.

## Purpose of QoS

**Quality of Service (QoS)** is how the network gives different kinds of traffic different treatment so that each meets its needs. Without QoS, a large file download could starve a live voice call of the timely delivery it requires. QoS sorts traffic into classes and assigns each class a priority and a set of performance targets — primarily latency, packet loss, and jitter.

## Traffic classes

We use standardized QoS class identifiers. The key ones:

- **Conversational voice** — highest priority, reserved for real-time voice.
- **Real-time streaming** — high priority, tolerant of slightly more delay.
- **Interactive / best-effort data** — default classes for general traffic.

## VoLTE requirements

**VoLTE (Voice over LTE)** carries voice as packets over LTE and is therefore entirely dependent on QoS to sound acceptable. VoLTE traffic must be carried on the **conversational voice** class. The policy targets for that class are:

- **One-way packet latency budget: 100 ms.**
- Packet loss: under 1%.
- Guaranteed bit rate appropriate to the voice codec.

If VoLTE traffic is not placed on the conversational-voice class, or the latency budget is exceeded, callers experience clipping, delay, and dropped calls.

## Enforcement

QoS is enforced end-to-end — on the radio scheduler and across the core transport. Policy is applied per bearer when a session is established. Changes to class targets require Architecture review.
