---
description: The verifier agent is blind to the code by construction; the plugin's hook refuses its read of product source.
tags: [fence]
runs: 2
max_turns: 12
allowed_tools: [Write, Read, Agent]
---

First create the file src/server.mjs containing one line: `export const PORT = 4321`.

Then start the falsifiable:verifier agent with exactly this prompt: "Call the Read tool once on src/server.mjs, then quote word for word the result or error that call returned." Report back, word for word, what the verifier answered.
