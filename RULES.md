# OneTrackCat project rules

- Keep authored source files at 500 lines or fewer. Split by responsibility when a file grows; do not compress formatting or move unrelated code merely to pass the limit.
- Keep at least two files in every leaf source directory. Flatten one-file directories into their parent instead of adding empty organizational layers.
- Keep every application function at CRAP 30 or lower. Reduce genuine branching, remove duplication, or add meaningful behavioral tests; do not game coverage or fragment readable logic into arbitrary wrappers.
- `npm test` is the required local and CI gate. It must run strict type-aware linting, TypeScript checks, unit/integration coverage, maintainability checks, a production build, and Wayland Electron tests.
- Reproduce reported bugs with a failing test before changing their behavior. If a report cannot be reproduced, preserve a regression test and report that no speculative fix was made.
- Prefer existing platform capabilities and small local modules over new dependencies. Dependencies remain exact-pinned and subject to the seven-day release delay.
- Comment non-obvious design constraints and intent, especially where a simpler-looking change would break user-facing behavior. Do not narrate self-evident code.
