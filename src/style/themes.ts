// The color schemes of the hud style: one color for each role, and the five stops of the
// gauge gradient (calm, lime, warn, crit, full). The 16-color tier ignores the scheme: there
// the terminal's own palette decides, through the codes in CODES16.
//
// A named scheme shows in three places: the model segment (lead) and the folder segment
// (place) are filled with its accent colors, with dark text; the data segments take its
// surface colors; and the calm part of each gauge takes its accent hues. The warn and
// critical colors stay amber and red in every scheme, so a warning reads the same.
// `default` keeps lead and place on its dark fill.
//
// The named schemes take their colors from the published palettes. A few roles use a
// darker or lighter shade than the palette has, so that text on the segment fill stays
// readable (test/style.test.ts checks the contrast); a comment marks each one.

export type RGB = [number, number, number]
/** One color in all tiers: RGB (truecolor, and the nearest 256-color index) and the 16-color codes. */
export type Col = { rgb: RGB; fg16: number; bg16: number }

export const ROLES = [
  'chrome1', //    data segment background
  'chrome2', //    the other data segment background (16 colors: the same black)
  'track', //      gauge track
  'text', //       values, timer, task label
  'muted', //      labels, details, countdown
  'lead', //       model segment background
  'model', //      model name, on lead
  'place', //      folder segment background
  'folder', //     folder, on place
  'branch', //     branch, on place
  'fillDim', //    the host over SSH, and "…" for no model: on place and lead
  'cyan', //       skill badge fill, spinner
  'badgeText', //  text on the skill badge
  'amber', //      value at the warn level
  'red', //        alarm fill (critical level)
  'alarmText', //  text on the alarm fill
  'alarmFill', //  gauge fill inside the alarm
  'alarmTrack', // gauge track inside the alarm
] as const
export type Role = (typeof ROLES)[number]

/** The 16-color foreground and background code of each role, the same in every scheme. */
const CODES16: Record<Role, [number, number]> = {
  chrome1: [30, 40], chrome2: [30, 40], track: [37, 40], text: [97, 107], muted: [37, 47],
  lead: [30, 40], model: [97, 107], place: [30, 40], folder: [96, 106], branch: [95, 105], fillDim: [37, 47],
  cyan: [96, 46], badgeText: [30, 40],
  amber: [93, 103], red: [91, 41], alarmText: [97, 107], alarmFill: [93, 103], alarmTrack: [30, 40],
}

type Scheme = Record<Role, string> & { gradient: [string, string, string, string, string]; light?: true }

const SCHEMES = {
  default: {
    chrome1: '#14161c', chrome2: '#252833', track: '#343946', text: '#e6edf3', muted: '#9aa4b2',
    lead: '#252833', model: '#b794ff', place: '#252833', folder: '#7dd3fc', branch: '#f472b6', fillDim: '#9aa4b2',
    cyan: '#22d3ee', badgeText: '#04222a',
    amber: '#fbbf24', red: '#ff4d5e', alarmText: '#14060a', alarmFill: '#ffe14d', alarmTrack: '#7a1626',
    gradient: ['#2dd4bf', '#a3e635', '#fbbf24', '#ff4d5e', '#ff2e88'],
  },
  // The hud shapes in the terminal's own 16 colors: hud() draws it in the 16-color tier.
  terminal: {
    chrome1: '#14161c', chrome2: '#252833', track: '#343946', text: '#e6edf3', muted: '#9aa4b2',
    lead: '#252833', model: '#b794ff', place: '#252833', folder: '#7dd3fc', branch: '#f472b6', fillDim: '#9aa4b2',
    cyan: '#22d3ee', badgeText: '#04222a',
    amber: '#fbbf24', red: '#ff4d5e', alarmText: '#14060a', alarmFill: '#ffe14d', alarmTrack: '#7a1626',
    gradient: ['#2dd4bf', '#a3e635', '#fbbf24', '#ff4d5e', '#ff2e88'],
  },
  // Catppuccin Mocha
  catppuccin: {
    chrome1: '#181825', chrome2: '#313244', track: '#45475a', text: '#cdd6f4', muted: '#a6adc8',
    lead: '#cba6f7', model: '#11111b', // mauve
    place: '#89b4fa', folder: '#11111b', branch: '#313244', fillDim: '#45475a', // blue
    cyan: '#94e2d5', badgeText: '#11111b',
    amber: '#f9e2af', red: '#f38ba8', alarmText: '#11111b', alarmFill: '#f9e2af',
    alarmTrack: '#7d3a50', // not in the palette: red over base
    gradient: ['#89b4fa', '#cba6f7', '#f9e2af', '#fab387', '#f38ba8'], // blue, mauve
  },
  // Catppuccin Latte, for light terminals
  'catppuccin-latte': {
    light: true,
    chrome1: '#eff1f5', chrome2: '#e6e9ef', track: '#ccd0da', text: '#4c4f69', muted: '#6c6f85',
    lead: '#8839ef', model: '#eff1f5', // mauve
    place: '#1e66f5', folder: '#ffffff', branch: '#dce0e8', fillDim: '#ccd0da', // blue
    cyan: '#0f7a80', // darker than the palette's teal (#179299), for white text; its blue is the folder fill
    badgeText: '#ffffff',
    amber: '#a35c00', // darker than the palette's yellow (#df8e1d), which is too light on the fill
    red: '#d20f39', alarmText: '#eff1f5', alarmFill: '#f9d27a',
    alarmTrack: '#8a0b26', // not in the palette: a darker red
    gradient: ['#1e66f5', '#8839ef', '#df8e1d', '#fe640b', '#d20f39'], // blue, mauve
  },
  nord: {
    chrome1: '#2e3440', chrome2: '#3b4252', track: '#4c566a', text: '#eceff4',
    muted: '#aab3c3', // between nord3 and nord4: nord3 is too dark on the fill
    lead: '#88c0d0', model: '#2e3440', // nord8
    place: '#81a1c1', folder: '#2e3440', branch: '#3b4252', fillDim: '#434c5e', // nord9
    cyan: '#a3be8c', // nord14: the frost colors are the fills
    badgeText: '#2e3440',
    amber: '#ebcb8b',
    red: '#b3505a', // darker than nord11 (#bf616a), for white text on it
    alarmText: '#ffffff', alarmFill: '#ebcb8b',
    alarmTrack: '#6e2c33', // not in the palette: a darker nord11
    gradient: ['#5e81ac', '#88c0d0', '#ebcb8b', '#d08770', '#bf616a'], // nord10, nord8
  },
  dracula: {
    chrome1: '#21222c', chrome2: '#44475a', track: '#565a75', text: '#f8f8f2',
    muted: '#c0c5de', // lighter than the comment color (#6272a4), which is too dark on the fill
    lead: '#bd93f9', model: '#21222c', // purple
    place: '#ff79c6', folder: '#21222c', branch: '#44475a', fillDim: '#44475a', // pink
    cyan: '#8be9fd', badgeText: '#21222c',
    amber: '#f1fa8c', red: '#ff5555', alarmText: '#21222c', alarmFill: '#f1fa8c',
    alarmTrack: '#8a2a35', // not in the palette: a darker red
    gradient: ['#bd93f9', '#ff79c6', '#f1fa8c', '#ffb86c', '#ff5555'], // purple, pink
  },
  // Gruvbox dark
  gruvbox: {
    chrome1: '#1d2021', chrome2: '#3c3836', track: '#504945', text: '#ebdbb2', muted: '#a89984',
    lead: '#83a598', model: '#1d2021', // blue
    place: '#8ec07c', folder: '#1d2021', branch: '#3c3836', fillDim: '#504945', // aqua
    cyan: '#d3869b', // purple: aqua is the folder fill
    badgeText: '#1d2021',
    amber: '#fabd2f', red: '#fb4934', alarmText: '#1d2021', alarmFill: '#fabd2f',
    alarmTrack: '#7c1f1a', // not in the palette: a darker red
    gradient: ['#83a598', '#8ec07c', '#fabd2f', '#fe8019', '#fb4934'], // blue, aqua
  },
  // Tokyo Night (night)
  'tokyo-night': {
    chrome1: '#1f2335', // bg of the storm variant: night's #16161e is near the default's fill
    chrome2: '#292e42', track: '#3b4261', text: '#c0caf5',
    muted: '#9099c4', // between dark5 and fg_dark: dark5 is too dark on the fill
    lead: '#7aa2f7', model: '#16161e', // blue
    place: '#bb9af7', folder: '#16161e', branch: '#292e42', fillDim: '#414868', // magenta
    cyan: '#2ac3de', badgeText: '#16161e',
    amber: '#e0af68', red: '#f7768e', alarmText: '#16161e', alarmFill: '#e0af68',
    alarmTrack: '#7a2a3f', // not in the palette: a darker red
    gradient: ['#7aa2f7', '#7dcfff', '#e0af68', '#ff9e64', '#f7768e'], // blue, cyan
  },
} satisfies Record<string, Scheme>

export type ThemeName = keyof typeof SCHEMES
export const THEME_NAMES = Object.keys(SCHEMES) as ThemeName[]

export type Theme = Record<Role, Col> & { gradient: [RGB, RGB, RGB, RGB, RGB]; light: boolean }

export const hexRgb = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB

const built = new Map<ThemeName, Theme>()

/** The colors of a scheme in all tiers. */
export function theme(name: ThemeName): Theme {
  let t = built.get(name)
  if (!t) {
    const s: Scheme = SCHEMES[name]
    const roles = Object.fromEntries(ROLES.map(r => [r, { rgb: hexRgb(s[r]), fg16: CODES16[r][0], bg16: CODES16[r][1] }]))
    t = { ...(roles as Record<Role, Col>), gradient: s.gradient.map(hexRgb) as Theme['gradient'], light: s.light === true }
    built.set(name, t)
  }
  return t
}

/** The WCAG contrast ratio of two colors, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const lum = (c: RGB) => {
    const [r, g, bl] = c.map(v => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }) as RGB
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
