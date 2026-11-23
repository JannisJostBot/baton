<!-- taskboard:start -->
## Task board (tb)

This repo tracks work on a task board stored on the git branch `taskboard`. It is **not** part of the working tree, so you never commit it with code, and updating it never touches uncommitted work. Use it so that parallel sessions and future sessions know what is going on without re-reading the code.

**At the start of every session**, before exploring the code, run:

    node tb.mjs context

Trust what it says about finished and in-progress work instead of re-discovering it.

**Workflow**
1. Find the task that matches your assignment (`node tb.mjs show <ID>`), or create one:
   `node tb.mjs add "Short title" -d "what and why" --steps "step one; step two"`
2. Claim it: `node tb.mjs start <ID>`
3. After each meaningful step, record progress, and tick steps off:
   `node tb.mjs log <ID> "what you did, what is left, files touched"`
   `node tb.mjs tick <ID> <step-key>` · add steps: `node tb.mjs steps <ID> "new step"`
4. Problems, open questions, decisions the human must make:
   `node tb.mjs issue <ID> "description"` · when settled: `node tb.mjs resolve <ID> <issue-key> "how"`
5. Finished and tested: `node tb.mjs move <ID> review` (the human checks it), or `node tb.mjs done <ID> "summary"` if no review is needed. If you cannot continue: `node tb.mjs move <ID> blocked` plus an issue.

**Rules**
- Write log entries so a fresh agent could continue from `node tb.mjs show <ID>` alone: decisions, file names, the next step.
- Keep tasks small; split big work into several tasks (`--parent <ID>`).
- Never mark a task done that is untested or only partly done.
- In cloud/remote sessions (fresh clone each time), run `node tb.mjs sync` at the start and after each update, so other sessions see your changes.
- Run `node tb.mjs help` for all commands. Task IDs can be written as `TB-4` or just `4`.
<!-- taskboard:end -->
