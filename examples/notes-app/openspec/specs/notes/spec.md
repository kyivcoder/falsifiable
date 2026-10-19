# notes Specification

## Purpose
How a user keeps short notes: adding one in the page or through the API, and seeing the list of notes, newest first.

## Requirements

### Requirement: The app reports that it is running
`GET /health` SHALL answer status 200 with the JSON body `{"status": "ok"}` while the server is running.

#### Scenario: Health check
- **WHEN** a client requests `GET /health`
- **THEN** the answer is status 200 with `{"status": "ok"}`

### Requirement: Notes are listed newest first
`GET /api/notes` SHALL answer status 200 with `{"notes": [...]}`, holding every note the server has stored, newest first. Each note SHALL have a numeric `id`, its `text` and a `createdAt` timestamp. Notes SHALL be kept in memory only, so a restart of the server SHALL start with no notes.

#### Scenario: No notes yet
- **WHEN** a client requests `GET /api/notes` from a server that has just started
- **THEN** the answer is status 200 with `{"notes": []}`

#### Scenario: Newest first
- **WHEN** a client adds the note "first" and then the note "second", and requests `GET /api/notes`
- **THEN** the list holds "second" and then "first"

### Requirement: A note can be added through the API
`POST /api/notes` with a JSON object that has a `text` string SHALL store a new note with the text trimmed, and SHALL answer status 201 with `{"note": {...}}`. The text SHALL be 1 to 280 characters once trimmed. Other fields in the body SHALL be ignored.

#### Scenario: Adding a note
- **WHEN** a client posts `{"text": "  Buy milk  "}` to `/api/notes`
- **THEN** the answer is status 201 with a note whose text is "Buy milk"
- **AND** `GET /api/notes` lists that note

#### Scenario: The longest note
- **WHEN** a client posts a note whose text is 280 characters long
- **THEN** the answer is status 201

### Requirement: An invalid note is refused
The API SHALL refuse a new note with status 400 and a JSON body `{"error": "<what is wrong>"}` when the body is not valid JSON, is not a JSON object, has no `text` string, or has a text that is empty or longer than 280 characters once trimmed. A body larger than 10 KB SHALL be refused with status 413. A refused note SHALL NOT be stored.

#### Scenario: Not JSON
- **WHEN** a client posts a body that is not valid JSON
- **THEN** the answer is status 400 with an error saying the body must be valid JSON

#### Scenario: Missing or empty text
- **WHEN** a client posts `{}`, or `{"text": "   "}`
- **THEN** the answer is status 400 with an error that names the text
- **AND** `GET /api/notes` does not list a new note

#### Scenario: Text too long
- **WHEN** a client posts a note whose text is 281 characters long
- **THEN** the answer is status 400 with an error saying the text must be at most 280 characters

#### Scenario: Body too large
- **WHEN** a client posts a body larger than 10 KB
- **THEN** the answer is status 413 with an error that gives the limit

### Requirement: The page lists notes and adds one
`GET /` SHALL serve a page that lists the stored notes newest first, each with its text and the time it was added, and has a field and an "Add note" button to add a note. While the list loads, the page SHALL say so; with no notes it SHALL say "No notes yet."; when the API refuses a note, the page SHALL show the API's error message and keep what the user typed.

#### Scenario: Adding a note in the page
- **WHEN** a user opens the page, types "Buy milk" and chooses "Add note"
- **THEN** "Buy milk" appears at the top of the list with the time it was added
- **AND** the field is empty again

#### Scenario: An empty list
- **WHEN** a user opens the page on a server with no notes
- **THEN** the page says "No notes yet."

#### Scenario: A refused note
- **WHEN** a user types only spaces and chooses "Add note"
- **THEN** the page shows the error "text must not be empty"
- **AND** the list does not change

#### Scenario: The app is not reachable
- **WHEN** the page cannot load the notes
- **THEN** it says the notes could not be loaded and to reload the page
