export interface QuickAction {
  title: string;
  symbol: string;
  subtitle: string;
  metadata: unknown;
}
export const quickActions: QuickAction[] = [
  {
    title: "High five",
    symbol: "✋",
    subtitle: "Sapa dengan semangat",
    metadata: {
      actions: [
        {
          pose: "greeting",
          expression: "smile",
          gesture: "wave",
          duration_ms: 2400,
          speech_ja: "ハイタッチ！今日もよろしくね！",
        },
      ],
    },
  },
  {
    title: "Semangati aku",
    symbol: "✦",
    subtitle: "Sedikit energi baru",
    metadata: {
      actions: [
        {
          pose: "celebrate",
          expression: "smile",
          gesture: "excited_hands",
          duration_ms: 3200,
          speech_ja: "大丈夫。一緒に、一歩ずつ頑張ろう！",
        },
      ],
    },
  },
  {
    title: "Pose lucu",
    symbol: "♡",
    subtitle: "Malu, lalu kedip",
    metadata: {
      actions: [
        {
          pose: "shy",
          expression: "blush",
          gesture: "tilt",
          duration_ms: 1800,
          speech_ja: "ちょっと恥ずかしいな。",
        },
        {
          pose: "greeting",
          expression: "wink",
          gesture: "wave",
          duration_ms: 2200,
          speech_ja: "どうかな？",
        },
      ],
    },
  },
  {
    title: "Tarik napas",
    symbol: "☾",
    subtitle: "Jeda santai sebentar",
    metadata: {
      actions: [
        {
          pose: "relaxed",
          expression: "smile",
          gesture: "none",
          duration_ms: 5000,
          speech_ja: "少し休もう。ゆっくり息を吸って、吐いて。",
        },
      ],
    },
  },
  {
    title: "Dance kecil",
    symbol: "♫",
    subtitle: "Goyang badan, lalu salam",
    metadata: {
      actions: [
        {
          pose: "celebrate",
          expression: "smile",
          gesture: "dance",
          duration_ms: 3600,
          speech_ja: "一緒にリズムに乗ろう！",
        },
        {
          pose: "greeting",
          expression: "smile",
          gesture: "bow",
          duration_ms: 2000,
          speech_ja: "見てくれてありがとう！",
        },
      ],
    },
  },
  {
    title: "Pamer gaya",
    symbol: "✌",
    subtitle: "Hati, peace, lalu pose usil",
    metadata: {
      actions: [
        {
          pose: "shy",
          expression: "blush",
          gesture: "heart",
          duration_ms: 2200,
          speech_ja: "ハートをどうぞ！",
        },
        {
          pose: "confident",
          expression: "wink",
          gesture: "peace",
          duration_ms: 2200,
        },
        {
          pose: "confident",
          expression: "smile",
          gesture: "money",
          duration_ms: 2200,
          speech_ja: "じゃーん！どうかな？",
        },
      ],
    },
  },
  {
    title: "Jeda teh",
    symbol: "☕",
    subtitle: "Minum teh, lalu cek ponsel",
    metadata: {
      actions: [
        {
          pose: "relaxed",
          expression: "smile",
          gesture: "sip_tea",
          duration_ms: 3000,
          speech_ja: "ちょっとお茶にしよう。",
        },
        {
          pose: "thinking",
          expression: "neutral",
          gesture: "check_phone",
          duration_ms: 2200,
        },
      ],
    },
  },
  {
    title: "Cilukba",
    symbol: "☆",
    subtitle: "Condong kiri-kanan dan memantul",
    metadata: {
      actions: [
        {
          pose: "thinking",
          expression: "wink",
          gesture: "lean_left",
          duration_ms: 1500,
          speech_ja: "どこを見ているの？",
        },
        {
          pose: "greeting",
          expression: "smile",
          gesture: "lean_right",
          duration_ms: 1500,
        },
        {
          pose: "celebrate",
          expression: "smile",
          gesture: "bounce",
          duration_ms: 2200,
          speech_ja: "ここだよ！",
        },
      ],
    },
  },
];
export function CompanionPlayground({
  onPlay,
  disabled = false,
}: {
  onPlay: (action: QuickAction) => void;
  disabled?: boolean;
}) {
  return (
    <div className="quick-action-grid">
      {quickActions.map((action) => (
        <button
          key={action.title}
          disabled={disabled}
          onClick={() => onPlay(action)}
          className="quick-action-card"
        >
          <span className="quick-symbol" aria-hidden="true">
            {action.symbol}
          </span>
          <span>
            <strong>{action.title}</strong>
            <small>{action.subtitle}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
