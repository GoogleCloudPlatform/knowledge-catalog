# Network Engineering Glossary

**Owner:** Mobile Core Engineering **Audience:** New network and platform engineers

A shared reference for the mobile-network terms that come up daily. Brief definitions; deeper treatment lives in the dedicated design docs.

**APN (Access Point Name).** The APN is the identifier a device presents to the network to say *which packet data network it wants to reach*. It tells the core which gateway to route a data session through — for example, a public-internet APN versus an internal IMS APN for voice signaling. The APN is part of the device's data profile and is applied when a data session is established. Different APNs can map to different services and policies.

**IMSI (International Mobile Subscriber Identity).** The IMSI is the globally unique identity of a subscriber, provisioned onto the SIM. It is what the network uses to recognize and authenticate a subscriber. Because it uniquely identifies the subscriber, the IMSI is the key reference used when subscribers connect — at home or, via roaming, on another operator's network.

**QoS (Quality of Service).** QoS is the set of mechanisms that prioritize traffic and hold it to performance targets — latency, packet loss, and throughput. Traffic is sorted into classes, and each class is given a treatment appropriate to its needs. Real-time services need stricter QoS than best-effort data.

**VoLTE (Voice over LTE).** VoLTE carries voice calls as packets over the LTE data network (via IMS) rather than over the legacy circuit-switched voice path. Because voice is delay-sensitive, VoLTE depends on a high-priority QoS class to keep calls clear; the specific QoS targets are defined in the QoS Policy.

## Usage note

"SIM identity" is sometimes used loosely to mean the IMSI; prefer "IMSI" in engineering docs. Voice-over-LTE, VoLTE, and "IMS voice" all refer to the same service.
