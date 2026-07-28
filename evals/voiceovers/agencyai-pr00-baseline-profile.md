# AgencyAI PR 00 — immutable local product profile and source closure

Internal demo proving the untouched baseline, the immutable `local-mvp` contract, enterprise-source closure, and the unchanged canonical task flow.

1. I begin at the recorded upstream baseline, commit `1f41a52070cbc400b17b05136533e8d3737e25da`, using a fresh temporary profile and a disposable local workspace. I create a task, send the canonical prompt, and see an assistant message that says exactly `core-flow ok`.

2. Now I launch the PR 00 branch through its local-profile command. The build-info evidence reports `local-mvp`, and an attempted mutation leaves the build-selected profile and its nested values unchanged.

3. The profile evidence shows the exact PR 00 capability matrix: browser automation and computer use are true in the profile, while every cloud, remote, sharing, analytics, update, hosted-search, voice, Google Workspace, runtime-download, and runtime-plugin-install flag is false. This is the profile contract that later PRs will enforce at their runtime boundaries.

4. I try invalid profile combinations and launch-time or runtime override candidates that would turn excluded flags back on. Validation rejects the invalid inputs, and the effective `local-mvp` projection keeps every build-disabled flag false.

5. I run the source-closure guard on the PR 00 tree and it reports no tracked `/ee` path or executable build reference. I then run the same guard against a temporary hostile fixture, and it fails with the expected `/ee` finding.

6. Finally, I repeat the canonical task on the PR 00 head and again see the assistant reply exactly `core-flow ok`. The evidence records the exact PR 00 commit and confirms that the primary checkout’s branch, commit, and status match the snapshot taken before this worktree run.
