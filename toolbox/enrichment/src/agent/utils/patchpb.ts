// Patch Protobuf to make it work with static bundlers.
// Ensure this is loaded before any other modules are loaded.
//
// When compiling a standalone binary using `bun build --compile`, Bun's static analyzer
// misses protobufjs's dynamic `require("long")` calls. This module explicitly imports
// and registers `long` globally so that protobufjs successfully resolves 64-bit integers
// at runtime. Protobuf is a dependency of the Google ADK.
//
// https://github.com/protobufjs/protobuf.js/issues/2285

import Long from 'long';
import * as protobufMinimal from 'protobufjs/minimal.js';
import * as protobuf from 'protobufjs';

(globalThis as any).Long = Long;
protobufMinimal.util.Long = Long as any;
protobufMinimal.configure();
protobuf.util.Long = Long as any;
protobuf.configure();
