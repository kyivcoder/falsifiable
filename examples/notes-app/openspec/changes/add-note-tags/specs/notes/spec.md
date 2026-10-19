## ADDED Requirements

### Requirement: Notes carry the tags written in their text
A tag SHALL be a `#` at the start of a note's text or after whitespace, followed by one or more letters of any script (with their combining marks), digits, `-` or `_`. When a note is stored, the API SHALL read its tags from the text, put them in Unicode NFC form, lower-case them and keep each one once, in the order they first appear; the text SHALL be stored as written. Every note the API returns SHALL have a `tags` list, empty when the text has no tags. The page SHALL show each note's tags with the note.

#### Scenario: A note with tags in the page
- **WHEN** a user types "Call the plumber #home #urgent" in the page and chooses "Add note"
- **THEN** the note appears at the top of the list with the tags "home" and "urgent"

#### Scenario: Tags are read from the text
- **WHEN** a note is stored with the text "Fix the C# build #Work #work #home-office"
- **THEN** its tags are "work" and "home-office", in that order
- **AND** its text is "Fix the C# build #Work #work #home-office"

#### Scenario: Tags in any script
- **WHEN** a note is stored with the text "Plan the trip #हिंदी #होम #Café"
- **THEN** its tags are "हिंदी", "होम" and "café", each whole
- **AND** a "#café" typed as "e" followed by a combining accent is the same tag "café"

### Requirement: The list can be filtered by tag
`GET /api/notes?tag=<tag>` SHALL answer only the notes that carry that tag, newest first, matching the tag without regard to case or Unicode normal form. In the page, choosing a tag on a note SHALL list only the notes with that tag and say which tag is shown, and an "All notes" control SHALL list every note again.

#### Scenario: Filtering by a tag
- **WHEN** notes tagged "home" and notes tagged "work" exist, and a user chooses the tag "work" on a note in the page
- **THEN** only the notes tagged "work" are listed, and the page says it is showing "work"
- **AND** `GET /api/notes?tag=Work` answers the same notes
- **AND** choosing "All notes" lists every note again
