# Batch Import Formats & Template Tokens

This document details the file formats supported for importing prompt batches into **Batch Studio**, as well as the dynamic filename template tokens used for automatic file naming.

---

## 1. Text Import (`.txt`)

The plain-text import format is designed for straightforward lists of prompts.

### Rules:
- **One prompt per line**.
- Leading and trailing whitespace on each line is trimmed.
- Empty or whitespace-only lines are automatically skipped.
- UTF-8 encoding is recommended.

### Example:
```text
A cinematic shot of a lone nomad crossing golden sand dunes at sunset
Close-up portrait of the nomad looking toward a starry desert oasis
An aerial wide view of the ancient oasis surrounded by illuminated palm trees
```

---

## 2. CSV Import (`.csv`)

Batch Studio supports full **RFC 4180** compliant CSV files. Prompts can span multiple lines when wrapped in quotes, and commas inside quoted text are safely escaped.

### Supported Columns (Case-Insensitive):

| Column Header | Type | Description | Example Values |
| :--- | :--- | :--- | :--- |
| `prompt` *(Required)* | String | The text prompt for generation. | `"A drone shot over turquoise waters"` |
| `name` | String | Optional display name for the task in the queue. | `"Scene 1 - Desert Entry"` |
| `references` | String | Semicolon-separated list of reference image filenames or IDs. | `"nomad.png;style_ref.jpg"` |
| `aspect_ratio` | String | Aspect ratio override for this task. | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"` |
| `duration` | Number | Video duration in seconds (for video tasks). | `4`, `5`, `6`, `8`, `10` |
| `model` | String | Model identifier override. | `"veo_2"`, `"imagen_3"` |
| `video_mode` | String | Workflow sub-mode for video tasks. | `"text_to_video"`, `"image_to_video"`, `"start_end_frame"`, `"reference_ingredients"` |
| `output_count` | Number | Number of outputs to generate for this task. | `1`, `2`, `3`, `4` |
| `prefix_override`| String | Custom prefix instruction specifically for this prompt. | `"High quality 8k render, photorealistic"` |
| `disable_prefix` | Boolean| If `true`, disables the global prefix for this task. | `true`, `false` |

### Headerless Fallback Mode:
If the CSV does not contain a recognizable header row, Batch Studio uses positional column mapping:
- Column 1: `prompt`
- Column 2: `name`
- Column 3: `references`

### Example CSV:
```csv
prompt,name,references,aspect_ratio,duration,video_mode,output_count
"A futuristic red supercar cruising down a rainy city boulevard with neon reflections",City Cruiser,car_ref.png,16:9,5,text_to_video,1
"Close-up of the glowing headlights reflecting in puddles",Headlight Detail,car_ref.png;neon_style.png,16:9,4,image_to_video,1
"Wide drone shot rising into the smoggy cyberpunk skyline",Skyline Ascent,,9:16,8,text_to_video,1
```

---

## 3. Global Prompt Prefix (Shared Instructions)

The **Global Prompt Prefix** allows you to enforce consistent style directives, character descriptions, or negative constraints across every prompt in a batch without manually copying them into every line.

### Key Behaviors:
- **Non-Destructive**: The prefix is stored separately from `originalPrompt`. Your source prompts remain intact.
- **Configurable Separator**: Defaults to two newlines (`\n\n`), customizable to commas, spaces, or single line breaks.
- **Retry Idempotency**: The prefix is resolved once per task preparation and never double-prepended during retries.
- **Per-Task Overrides**: In CSV imports, individual tasks can supply a `prefix_override` or set `disable_prefix=true`.

---

## 4. Filename Template Tokens

Batch Studio automatically formats the filenames of downloaded images and videos using dynamic template tokens.

### Available Tokens:

| Token | Description | Sample Output |
| :--- | :--- | :--- |
| `{number}` | Sequential auto-incrementing task or output number. | `001`, `002`, `003` |
| `{project}` | The name of the batch / project. | `Desert_Story`, `Cyberpunk_City` |
| `{prompt}` | Sanitized preview of the prompt text (truncated to 40 characters). | `A_futuristic_red_supercar_cruising_down` |
| `{date}` | Current date in `YYYY-MM-DD` format. | `2026-10-24` |
| `{time}` | Current time in `HHmmss` format. | `234512` |

### Template Examples:
- Default: `{number}_{project}_{date}` $\rightarrow$ `001_Desert_Story_2026-10-24.png`
- Scene-based: `{project}_{number}_{prompt}` $\rightarrow$ `SciFi_001_A_sleek_spacecraft_entering_orbit.mp4`
- Timestamped: `{date}_{time}_{number}` $\rightarrow$ `2026-10-24_234512_001.png`

### Automatic Numbering Options:
- **Toggle**: Enable or disable auto-numbering independently.
- **Start Number**: Configurable starting index (e.g. `1`, `100`).
- **Padding**: Number of zero-padded digits (`1` $\rightarrow$ `01`, `001`, `0001`).
- **Separator**: Delimiter between the number and other tokens (`_`, `-`).
