# Telecom Systems & Terminology Overview

**Audience:** New analysts and partners integrating with our subscriber systems **Owner:** Mobile Core Engineering

A meaning-first overview of how subscriber identity and data access fit together. Deliberately conceptual — no field or schema detail.

## Identity: the IMSI

At the center of a mobile subscriber sits the **IMSI (International Mobile Subscriber Identity)**. It is the globally unique identifier of the subscriber, held on the SIM, and it is what the network authenticates when a device tries to connect. Think of the IMSI as the subscriber's passport: it proves who they are to the home network and, when they travel, lets a visited network find and check with their home network. Almost everything the network does for a subscriber begins by resolving their IMSI.

## Data access: the APN

Identity gets you onto the network; the **APN (Access Point Name)** decides what you can reach. The APN names the packet data network a session should connect to, and so selects the gateway and the policies that apply. One subscriber may have several APNs — for instance a general internet APN and a separate IMS APN that carries voice signaling for VoLTE. Choosing the right APN is what makes a data session land on the right service with the right treatment.

## How they relate

The two are complementary: the IMSI answers *who is this subscriber?* and the APN answers *what network/service is this session for?* A subscriber must be authenticated by IMSI before any session is established, and each session then uses an APN to reach its destination. Misconfigure the IMSI and the device cannot attach at all; misconfigure the APN and the device attaches but cannot reach the intended service.

## Why this matters for data

When you see subscriber records or session logs, expect the IMSI to be the join key for "which subscriber," and the APN to indicate "which service/network" a session used. Keeping the distinction clear avoids conflating *identity* with *access*.
