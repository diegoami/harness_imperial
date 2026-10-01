# T<nn> <Title>

- **Kind**: feature | correction (of T<nn>, bug #<n>) | slice | infrastructure
- **Issue**: #<n> · **Branch**: `task/T<nn>-<slug>` · **Merge after**: T<nn>, …
- **Implementer**: opencode (the default, `deepseek-flash`; or `<model>` from harness.json) · **Claude fallback**: sonnet | opus
- **Reviewer**: opencode (the default, `luna`: GPT-6 Luna on OpenAI), then claude opus | claude (opus | sonnet); never the implementer's family
- **Evidence**: the reports, fixtures or investigations this task rests on, with links.
- **Owns**: directories or files, e.g. `src/Calendar/**`, `tests/Calendar/**`.
- **Scope**: what to build, in a few sentences. What is out of scope, if it is easy to confuse.
- **Done when**:
  1. One check a command can run, with the expected result.
  2. …
  3. The build and the test suite are green.
- **Hazards**: the mistake an implementer is most likely to make here, and how to avoid it.
