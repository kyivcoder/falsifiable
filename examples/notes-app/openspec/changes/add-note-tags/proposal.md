# Proposal

## Why

Notes pile up in one list. A user who keeps notes for home and for work has to read the whole list to find the ones for one of them, and a script that reads the API has to fetch every note and filter them itself.

## What Changes

- **A note's tags are the `#words` in its text**, so there is no new field to fill in: "Call the plumber #home" is tagged "home". A tag may be written in any script.
- **The API returns each note's tags**, lower-cased and listed once, and answers `GET /api/notes?tag=home` with only the notes tagged "home".
- **The page shows the tags under each note.** Choosing one lists only the notes with that tag, and "All notes" lists every note again.
- Notes without tags work as before. Each note in an API answer gains a `tags` list, empty when the note has none.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `notes`: notes carry the tags written in their text, and the list can be filtered by tag.

## Impact

- **API** (the `api` domain): reading tags from the text, `tags` on every note, the `tag` filter on the list, and an API test for each.
- **Page** (the `web` domain): the tags under each note, the tag filter and "All notes".
- **Shared contract:** the note shape `{id, text, tags, createdAt}` and `GET /api/notes?tag=<tag>`. Both parts rely on it, so the plan gives it one owner.
- No new dependency and no stored data to migrate: notes live in memory.
