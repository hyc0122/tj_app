import { onUnmounted, ref } from "vue";

export interface PreviewableRoleAudio {
  id: number;
  name?: string;
  src?: string;
}

interface CurrentPlayback {
  id: number;
  audio: HTMLAudioElement;
  onEnded: () => void;
}

export function useRoleAudioPreview() {
  const playingId = ref<number | null>(null);
  const errorMessage = ref("");
  let current: CurrentPlayback | null = null;

  function releaseCurrent(): void {
    if (!current) return;
    const playback = current;
    playback.audio.removeEventListener("ended", playback.onEnded);
    playback.audio.pause();
    playback.audio.removeAttribute("src");
    playback.audio.load();
    if (current === playback) {
      current = null;
      playingId.value = null;
    }
  }

  function stop(): void {
    releaseCurrent();
  }

  function bindEnded(audio: HTMLAudioElement): () => void {
    const onEnded = () => {
      // 中文注释：只允许当前实例清空状态，旧 Audio 的 ended 不得拆掉新实例。
      if (current?.audio !== audio) return;
      current.audio.removeEventListener("ended", onEnded);
      current = null;
      playingId.value = null;
    };
    audio.addEventListener("ended", onEnded);
    return onEnded;
  }

  async function toggle(item: PreviewableRoleAudio): Promise<void> {
    errorMessage.value = "";
    if (!item.src) return;
    if (playingId.value === item.id) {
      stop();
      return;
    }
    stop();
    const audio = new Audio(item.src);
    const onEnded = bindEnded(audio);
    current = { id: item.id, audio, onEnded };
    playingId.value = item.id;
    try {
      await audio.play();
    } catch {
      if (current?.audio === audio) {
        stop();
        errorMessage.value = "音色试听失败，请稍后重试";
      }
    }
  }

  onUnmounted(() => {
    stop();
  });

  return {
    playingId,
    errorMessage,
    toggle,
    stop,
  };
}
