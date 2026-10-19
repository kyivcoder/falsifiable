# Fixture project

A project where every tag kind but lint has something to resolve against.

- An untagged list item before any rules section is not a rule.

## Rules
<!-- rules -->

- Never merge a pull request. [hook:gh-merge]
- Never publish the package. [hook:npm-publish]
- The tests pass. [check:test]
- Links resolve. [check:check-links]
- Notes are validated. [test:proof/notes.test.js]
- The diff matches the change. [review:scope]
- Quote a tag as `[review:x]` when you need one. [review:tests-prove]

## Notes

- An untagged item in a section without the marker is not a rule.
