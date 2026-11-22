import {
  FilmReelIcon,
  LightbulbIcon,
  MapPinIcon,
  MaskHappyIcon,
  MicrophoneIcon,
  ScrollIcon,
  VideoCameraIcon,
  WaveformIcon,
  type Icon,
} from '@phosphor-icons/react';

/**
 * One icon per stage, so the stages stay apart when the navigation shrinks
 * to a rail of icons, as it does on a tablet, and so the work board can show
 * where an agent is working.
 */
export const STAGE_ICONS: Readonly<Record<string, Icon>> = {
  development: LightbulbIcon,
  script: ScrollIcon,
  casting: MaskHappyIcon,
  design: MapPinIcon,
  shots: VideoCameraIcon,
  sound: WaveformIcon,
  edit: FilmReelIcon,
  audio: MicrophoneIcon,
};
