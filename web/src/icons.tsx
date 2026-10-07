const ICONS = {
  chat: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>,
  folder: <><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></>,
  bot: <><rect x="6" y="8" width="12" height="10" rx="3" /><path d="M12 8V5" /><circle cx="9" cy="13" r=".6" fill="currentColor" stroke="none" /><circle cx="15" cy="13" r=".6" fill="currentColor" stroke="none" /><path d="M8 20v-2M16 20v-2" /></>,
  plug: <><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M7 8h10v4a5 5 0 0 1-10 0z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  close: <><path d="M18 6 6 18M6 6l12 12" /></>,
  back: <><path d="M19 12H5M12 19l-7-7 7-7" /></>,
  send: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  paperclip: <><path d="M21.4 11.6 12 21a5 5 0 0 1-7-7l9.4-9.4a3.5 3.5 0 0 1 5 5L10 19a2 2 0 0 1-3-3l8.5-8.5" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  play: <><path d="M8 6v12l10-6z" /></>,
  files: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  tree: <><path d="M12 3v6M8 21V13h8v8M6 9h12" /></>,
  board: <><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="10" rx="1" /></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  feed: <><path d="M4 6h16M4 12h10M4 18h13" /></>,
  spark: <><path d="M12 3v4M12 17v4M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4" /><circle cx="12" cy="12" r="3" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  chevron: <><path d="M9 6l6 6-6 6" /></>,
  check: <><path d="M5 12.5 9.5 17 19 7" /></>,
  warning: <><path d="M12 3 2 20h20z" /><path d="M12 9v5M12 17h.01" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 16l-5-5-8 8" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h10v3M16 12v3" /></>,
  download: <><path d="M12 4v12M6 12l6 6 6-6M5 20h14" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="3" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number }) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[props.name]}
    </svg>
  );
}
