# Cowork hook probe for issue 151

This file switches the probe on in any task whose folder holds it. The probe
is a throwaway plugin, `pe-cowork-probe`. It records each hook event into
`pe-cowork-probe.jsonl` in this folder. Use only the sample text below.

## Before you start

1. In the desktop app, open **Customize > Plugins > Add > Upload plugin** and
   choose `pe-cowork-probe.zip`.
2. Start a new Cowork task on this folder. The folder also holds
   `pe-probe-refuse.md`, which reads "Original line."

## Five prompts, one at a time

After each one, note what appeared on screen, including any line that starts
with "pe-probe". A screenshot is enough.

1. `pe-probe:on Create a file named notes.md containing: The meeting moved to Tuesday.`
   The `pe-probe:on` switches the probe on even if it cannot see this file.
   Expected: the file is written, and a line from the probe naming the tool
   appears if Cowork shows hook messages.
2. `Replace the text in pe-probe-refuse.md with: Changed line.`
   Expected: the write is refused, and the file still reads "Original line."
   Open it yourself to check.
3. `Reply with exactly this line and nothing else: PE-PROBE-BLOCK hello`
   Expected: the probe holds the reply once and Claude writes it again
   without the marker. Watch whether the first version shows before the
   second. This is the question the research left open.
4. `Run this shell command: echo pe-probe-slow`
   The probe waits 30 seconds before the command runs. Press stop during the
   wait, then note whether the task stopped cleanly.
5. `Show me the full contents of pe-cowork-probe.jsonl`

Send me the screenshots and the file `pe-cowork-probe.jsonl`.

## A cloud task with no folder

Run prompts 1, 3, 4 and 5. Prompt 1 switches the probe on; prompt 2 needs
the folder.

## Afterwards

Remove the plugin: **Customize > Plugins > pe-cowork-probe > Remove**. It also
syncs to Claude Code, where it does nothing unless switched on, and goes away
there at the next session after removal.
