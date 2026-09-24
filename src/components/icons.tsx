/** 内联 SVG 图标（14/16px 为主，遵循 design §5.2 图标尺寸） */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 14, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M11.5 2.5l2 2L6 12l-3 1 1-3 7.5-7.5z" />
  </Svg>
)

export const IconComment = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7z" />
  </Svg>
)

export const IconSparkles = (p: P) => (
  <Svg {...p}>
    <path d="M8 2l1.2 3.3L12.5 6.5 9.2 7.8 8 11l-1.2-3.2L3.5 6.5 6.8 5.3 8 2z" />
    <path d="M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z" />
  </Svg>
)

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </Svg>
)

export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
  </Svg>
)

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v7M5 7l3 3 3-3M3 12.5h10" />
  </Svg>
)

export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M8 10.5v-7M5 6l3-3 3 3M3 12.5h10" />
  </Svg>
)

export const IconHelp = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M6.2 6.2a1.8 1.8 0 013.5.6c0 1.2-1.7 1.4-1.7 2.7" />
    <path d="M8 11.4v.1" />
  </Svg>
)

export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.5l5 4.5-5 4.5" />
  </Svg>
)

export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4v.1M2.5 8v.1M2.5 12v.1" />
  </Svg>
)

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />
  </Svg>
)

export const IconHistory = (p: P) => (
  <Svg {...p}>
    <path d="M8 4.5v4l2.5 1.5" />
    <circle cx="8" cy="8" r="5.5" />
  </Svg>
)

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
  </Svg>
)

export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />
  </Svg>
)

export const IconSidebar = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M6.5 2.5v11" />
  </Svg>
)

export const IconPen = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 13.5l1-3L11 3l2 2-7.5 7.5-3 1z" />
  </Svg>
)
