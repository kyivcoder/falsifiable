# Review checklist

Each item is a slug in backticks, a colon and what to check.

### Delivery
- `scope`: the diff does what the approved change says and nothing else.
- `tests-prove`: each new test fails without the change.

### Safety
- `secrets`: no credential in a committed file, fixture or log line.

```markdown
- `in-a-fence`: an example inside a code fence is not a slug.
```

- `no-colon` an item without the colon is not a slug.
