# Client Generation Prompt

You are generating the **{{TARGET_LANGUAGE}}** client for this local messaging app.
Write all output into **{{OUTPUT_DIR}}** and nowhere else.

First, read this repository's `CLAUDE.md` — it contains the rules you MUST follow.
Then read the source-of-truth specs it points to:

- `spec/protocol.md` — wire protocol
- `spec/behavior.md` — client offline state machine
- `spec/control-interface.md` — the CLI surface to expose
- `spec/platform/{{TARGET_LANGUAGE}}.md` — how {{TARGET_LANGUAGE}} realizes the above
- `spec/conformance/scenario_01.yaml` — the behavior your client must reproduce

Then do the following:

1. Implement the {{TARGET_LANGUAGE}} client into `{{OUTPUT_DIR}}`, faithful to every
   spec above. Expose the exact control interface and launch string from the
   platform file.
2. Verify your work before finishing (CLAUDE.md §6): build if the platform requires
   it, start `server/app.py`, exercise the control interface through the full
   online → offline-queue → reconnect → receive cycle, and run
   `conformance/run.py` against your client if it is available.
3. Write a short `README.md` in `{{OUTPUT_DIR}}` with build and run commands.

In your final message, report:
- the files you created,
- any place the spec was ambiguous or silent, and the minimal choice you made
  for each (do NOT edit the spec — surface the gap instead),
- exactly what you ran to verify, and the results.

Constraints (also in CLAUDE.md): write only inside `{{OUTPUT_DIR}}`; never modify
`spec/`, `server/`, `conformance/`, `harness/`, or the other client; no
messaging/chat SDKs; local only.