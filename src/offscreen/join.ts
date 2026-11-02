import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FlacOutputFormat,
  Input,
  MkvOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
  type MediaCodec,
} from 'mediabunny';

import type { DownloadPlan } from '../shared/jobs';
import { SaveError } from './plan';

/**
 * One file that plays from what was downloaded: picture and sound from two
 * files joined, an HLS stream's segments (TS or fMP4) repacked, all without re-encoding — packets
 * copied as they are by Mediabunny. MP4 when it can hold the codecs (it holds H.264, HEVC, VP9,
 * AV1, AAC, Opus, MP3…), Matroska otherwise. The metadata goes at the file's end: a player on the
 * computer does not mind, and nothing is kept in memory for it.
 */

/**
 * A plain file is already the video; segments, a TS file, or separate sound need joining, and the
 * sound alone is always taken out.
 */
export const needsJoin = (plan: DownloadPlan) =>
  !!plan.audioOnly || !!plan.audio || !!plan.video.segments?.length || plan.video.ext === 'ts';

function formatFor(codecs: (MediaCodec | null)[]): Mp4OutputFormat | MkvOutputFormat {
  const mp4 = new Mp4OutputFormat({ fastStart: false });
  const fits = codecs.every((c) => c && mp4.getSupportedCodecs().includes(c));
  return fits ? mp4 : new MkvOutputFormat();
}

const open = (file: Blob) => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

export interface Joined {
  /** mp4, mkv. */
  ext: string;
}

/**
 * Writes the joined video into `out`. `progress` gets 0–1. Throws SaveError('format') when the
 * downloaded files hold no picture Mediabunny can read.
 */
export async function join(
  video: Blob,
  audio: Blob | undefined,
  out: FileSystemFileHandle,
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Joined> {
  const inputs = [open(video), ...(audio ? [open(audio)] : [])];
  try {
    const picture = await inputs[0]!.getPrimaryVideoTrack().catch(() => null);
    if (!picture) throw new SaveError('format');
    const sound = audio
      ? await inputs[1]!.getPrimaryAudioTrack().catch(() => null)
      : await inputs[0]!.getPrimaryAudioTrack().catch(() => null);
    const format = formatFor([picture.codec, ...(sound ? [sound.codec] : [])]);
    const writable = await out.createWritable();
    const output = new Output({ format, target: new StreamTarget(writable, { chunked: true }) });
    if (audio) await interleave(picture, sound, output, video.size + audio.size, progress, signal);
    else await repack(inputs[0]!, output, progress, signal);
    return { ext: format.fileExtension.replace(/^\./, '') };
  } finally {
    for (const input of inputs) input.dispose();
  }
}

/** One file's tracks (an HLS stream, a TS file): Mediabunny's conversion, copying packets. */
function repack(
  input: Input,
  output: Output,
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return convert({ input, output, tracks: 'primary', showWarnings: false }, progress, signal);
}

async function convert(
  options: Parameters<typeof Conversion.init>[0],
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const conversion = await Conversion.init(options);
  if (!conversion.isValid) throw new SaveError('format');
  conversion.onProgress = (p) => progress(p);
  const stop = () => void conversion.cancel();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await conversion.execute();
  } finally {
    signal.removeEventListener('abort', stop);
  }
  signal.throwIfAborted();
}

/**
 * Picture and sound from two files, their packets added in time order — the muxer then never
 * holds one track waiting for the other. Both start where the earlier of them starts.
 */
async function interleave(
  picture: InputVideoTrack,
  sound: InputAudioTrack | null,
  output: Output,
  total: number,
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!picture.codec || (sound && !sound.codec)) throw new SaveError('format');
  const videoOut = new EncodedVideoPacketSource(picture.codec);
  output.addVideoTrack(videoOut);
  const audioOut = sound ? new EncodedAudioPacketSource(sound.codec!) : undefined;
  if (audioOut) output.addAudioTrack(audioOut);
  await output.start();
  const videoConfig = await picture.getDecoderConfig();
  const audioConfig = sound ? await sound.getDecoderConfig() : null;
  if (!videoConfig || (sound && !audioConfig)) throw new SaveError('format');
  const videoPackets = new EncodedPacketSink(picture).packets();
  const audioPackets = sound ? new EncodedPacketSink(sound).packets() : undefined;
  let v = await videoPackets.next();
  let a = audioPackets ? await audioPackets.next() : ({ done: true, value: undefined } as const);
  const shift = Math.min(
    v.done ? Infinity : v.value.timestamp,
    a.done ? Infinity : a.value.timestamp,
  );
  const at = (p: EncodedPacket) => (shift ? p.clone({ timestamp: p.timestamp - shift }) : p);
  let firstVideo = true;
  let firstAudio = true;
  let bytes = 0;
  let told = 0;
  try {
    while (!v.done || !a.done) {
      signal.throwIfAborted();
      if (!v.done && (a.done || v.value.timestamp <= a.value.timestamp)) {
        bytes += v.value.byteLength;
        await videoOut.add(at(v.value), firstVideo ? { decoderConfig: videoConfig } : undefined);
        firstVideo = false;
        v = await videoPackets.next();
      } else if (!a.done) {
        bytes += a.value.byteLength;
        await audioOut!.add(at(a.value), firstAudio ? { decoderConfig: audioConfig! } : undefined);
        firstAudio = false;
        a = await audioPackets!.next();
      }
      if (bytes - told > 4 << 20) {
        told = bytes;
        progress(Math.min(bytes / total, 0.99));
      }
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  }
}

/** The container a sound goes in as it is: AAC as M4A, Opus as .opus (Ogg), MP3, FLAC; else MKA. */
function soundFormat(codec: string | null): { format: Output['format']; ext: string } {
  switch (codec) {
    case 'aac':
      return { format: new Mp4OutputFormat({ fastStart: false }), ext: 'm4a' };
    case 'opus':
      return { format: new OggOutputFormat(), ext: 'opus' };
    case 'vorbis':
      return { format: new OggOutputFormat(), ext: 'ogg' };
    case 'mp3':
      return { format: new Mp3OutputFormat(), ext: 'mp3' };
    case 'flac':
      return { format: new FlacOutputFormat(), ext: 'flac' };
    default:
      return { format: new MkvOutputFormat(), ext: 'mka' };
  }
}

/**
 * The sound alone: as it is, without re-encoding; or as MP3 (LAME in WebAssembly, 192
 * kbit/s), decoded by the browser first. Throws SaveError('noAudio') for a video without sound.
 */
export async function extractAudio(
  source: Blob,
  out: FileSystemFileHandle,
  mp3: boolean,
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Joined> {
  const input = open(source);
  try {
    const track = await input.getPrimaryAudioTrack().catch(() => null);
    if (!track) throw new SaveError('noAudio');
    if (mp3 && !(await canEncodeAudio('mp3'))) registerMp3Encoder();
    const { format, ext } = mp3
      ? { format: new Mp3OutputFormat(), ext: 'mp3' }
      : soundFormat(track.codec);
    const writable = await out.createWritable();
    const output = new Output({ format, target: new StreamTarget(writable, { chunked: true }) });
    await convert(
      {
        input,
        output,
        tracks: 'primary',
        video: { discard: true },
        audio: mp3 ? { codec: 'mp3', bitrate: 192_000 } : undefined,
        showWarnings: false,
      },
      progress,
      signal,
    );
    return { ext };
  } finally {
    input.dispose();
  }
}
