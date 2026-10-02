import { Loader2, AlertTriangle } from 'lucide-react';
import type { MediaProbeResult } from '@/services/api';
import { formatDuration } from '@/lib/mediaSuggestions';

/**
 * One-line real-metadata readout for whichever file MediaPreviewPanel is
 * showing (duration + resolution/fps for video, duration + sample-rate/
 * channels for audio) -- the "analyze" half of "analyze and suggest".
 * Silent (renders nothing) when there's no active file yet or ffprobe
 * isn't available, rather than showing an empty/broken-looking box.
 */
export function MediaProbeInfo({
  probe,
  isLoading,
  kind,
}: {
  probe: MediaProbeResult | undefined;
  isLoading: boolean;
  kind: 'video' | 'audio';
}) {
  if (isLoading) {
    return (
      <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Reading file metadata…
      </p>
    );
  }
  if (!probe || !probe.available) return null;

  const parts: string[] = [];
  if (probe.duration_seconds != null) parts.push(formatDuration(probe.duration_seconds));
  if (kind === 'video' && probe.width && probe.height) parts.push(`${probe.width}×${probe.height}`);
  if (kind === 'video' && probe.fps) parts.push(`${probe.fps}fps`);
  if (kind === 'video' && probe.video_codec) parts.push(probe.video_codec);
  if (kind === 'audio' && probe.sample_rate) parts.push(`${probe.sample_rate}Hz`);
  if (kind === 'audio' && probe.channels) parts.push(probe.channels === 1 ? 'mono' : probe.channels === 2 ? 'stereo' : `${probe.channels}ch`);
  if (kind === 'audio' && probe.audio_codec) parts.push(probe.audio_codec);

  if (parts.length === 0) return null;

  return (
    <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded px-2 py-1.5">
      <span className="font-medium text-gray-600">Actual file:</span> {parts.join(' · ')}
      {kind === 'video' && probe.has_audio === false && (
        <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
          <AlertTriangle className="w-3 h-3" /> no audio track
        </span>
      )}
    </p>
  );
}
