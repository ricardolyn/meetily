/**
 * Plain-text transcript formatting for LLM prompts. Each line reads
 * `[MM:SS] You: ...` / `[MM:SS] Other: ...` so the model can tell who spoke.
 */

export interface TranscriptLine {
  text: string;
  audio_start_time?: number;
  speaker?: string;
}

export function formatTranscriptLine(line: TranscriptLine): string {
  const stamp = formatStamp(line.audio_start_time ?? 0);
  const who = line.speaker === 'me' ? 'You' : line.speaker === 'others' ? 'Other' : '';
  return who ? `[${stamp}] ${who}: ${line.text}` : `[${stamp}] ${line.text}`;
}

/** The whole transcript, one formatted line per segment. */
export function buildTranscriptText(lines: TranscriptLine[]): string {
  return lines.map(formatTranscriptLine).join('\n');
}

function formatStamp(seconds: number): string {
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
  const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}
