import { defineCommand, type Command } from '@imp/core';
import { z } from 'zod';

export const FfmpegStatus = z.object({
  available: z.boolean().describe('Whether Imp on this computer can use ffmpeg now.'),
  source: z
    .enum(['system', 'downloaded'])
    .nullable()
    .describe('system: the ffmpeg installed on this computer; downloaded: the one Imp fetched.'),
  canDownload: z.boolean().describe('Whether Imp can download ffmpeg for this computer.'),
  downloadBytes: z.number().nullable().describe('How large the download is, in bytes.'),
  downloading: z
    .object({ receivedBytes: z.number(), totalBytes: z.number() })
    .nullable()
    .describe('While a download runs, how far it got.'),
  error: z.string().nullable().describe('Why the last download failed, if it did.'),
});
export type FfmpegStatus = z.infer<typeof FfmpegStatus>;

/** The local server's ffmpeg, which it can download when the computer has none. */
export interface FfmpegService {
  status(): FfmpegStatus;
  /** Downloads it; `progress` is told as the download moves on. */
  install(progress?: (status: FfmpegStatus) => void): Promise<FfmpegStatus>;
}

/**
 * Written whenever ffmpeg's state changes, so that screens watching the
 * store notice (the export bar, the settings). Read the state itself with
 * system.ffmpeg.status: what is stored may be from before a restart.
 */
export const FFMPEG_STATE_KEY = 'system/ffmpeg';

/**
 * ffmpeg on the local server, as commands, so that an agent can check for it
 * and fetch it as the person can. Only the local server has these; in the
 * browser, films render with WebCodecs and nothing needs ffmpeg.
 */
export function createFfmpegCommands(ffmpeg: FfmpegService): readonly Command[] {
  return [
    defineCommand({
      id: 'system.ffmpeg.status',
      title: 'Check ffmpeg',
      description:
        'Says whether Imp on this computer has ffmpeg, which it uses to export films fast, to hear the sound inside video clips and to show agents stills of a cut. Without it the Edit screen records films in the browser in real time instead. Also says whether it can be downloaded and how far a download got.',
      effect: 'read',
      input: z.object({}),
      output: FfmpegStatus,
      handler: () => Promise.resolve(ffmpeg.status()),
    }),
    defineCommand({
      id: 'system.ffmpeg.install',
      title: 'Download ffmpeg',
      description:
        'Downloads ffmpeg (free software, about 20 to 30 MB) into Imp’s data folder on this computer, checks it against the expected file and starts using it at once, with no restart. Does nothing when ffmpeg is already there. Tell the person before you start it.',
      effect: 'write',
      input: z.object({}),
      output: FfmpegStatus,
      handler: async ({ runtime }) => {
        const tell = (status: FfmpegStatus): void => {
          void runtime.store.batch([
            {
              type: 'put',
              key: FFMPEG_STATE_KEY,
              value: { ...status, at: runtime.now().toISOString() },
            },
          ]);
        };
        try {
          const done = await ffmpeg.install(tell);
          tell(done);
          return done;
        } catch (error) {
          tell(ffmpeg.status());
          throw error;
        }
      },
    }),
  ];
}
