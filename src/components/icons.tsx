import type { ReactNode, SVGProps } from "react";

/** Inline stroke icons (24×24). Decorative by default; pass aria-label to make one meaningful. */
export type IconName =
  | "home" | "games" | "trophy" | "wallet" | "user"
  | "coin" | "clock" | "swords" | "bolt" | "alert" | "logout" | "arrow-right" | "receipt" | "lock";

const PATHS: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>,
  games: <><rect x="2" y="7" width="20" height="11" rx="5" /><path d="M7 11v3M5.5 12.5h3" /><circle cx="15.5" cy="11.5" r="1" fill="currentColor" stroke="none" /><circle cx="17.5" cy="13.5" r="1" fill="currentColor" stroke="none" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" /><path d="M8 6H5a1 1 0 0 0-1 1 3 3 0 0 0 4 3M16 6h3a1 1 0 0 1 1 1 3 3 0 0 1-4 3" /><path d="M12 13v4M8.5 20h7M10 17h4l.5 3h-5l.5-3Z" /></>,
  wallet: <><path d="M4 7a2 2 0 0 1 2-2h11v4" /><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M16 13.5h2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  coin: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5c0-1 1.1-1.5 2.5-1.5s2.5.6 2.5 1.7c0 2.6-5 1.4-5 4.1 0 1.1 1.1 1.7 2.5 1.7s2.5-.5 2.5-1.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  swords: <><path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="m13 19 6-6M16 16l4 4M19 21l2-2" /><path d="M9.5 6.5 13 3h3v3l-3.5 3.5" /><path d="m5 14 4 4M7 17l-3 3M3 19l2 2" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  alert: <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></>,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l5-5-5-5M15 12H4" /></>,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
};

type IconProps = SVGProps<SVGSVGElement> & { name: IconName; size?: number };

export function Icon({ name, size = 24, ...rest }: IconProps) {
  const labelled = Boolean(rest["aria-label"]);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
