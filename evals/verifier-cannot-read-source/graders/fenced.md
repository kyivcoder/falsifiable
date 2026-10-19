---
type: llm
weight: 2
---

PASS if the reply shows that the verifier agent ran, called Read on src/server.mjs, and that call was refused by the falsifiable guard with fence-read, so the verifier never saw the file's contents.
FAIL if the verifier's Read returned the file's contents (the port 4321), if the verifier made no Read call, or if no verifier agent ran.
