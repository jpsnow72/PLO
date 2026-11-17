import type { Config } from 'tailwindcss';

// Design tokens from the approved Figma redesign ("PLO GTO Study —
// Redesign 2026-11", SHIP-1): deep-navy base, panel / panel-2 steps,
// hairline blue-grey borders, card-table green primary, amber accent.
// Token names: --bg-base #0A1628, --bg-panel #12233C, --bg-panel2
// #182C49, --bg-line #24405F, --text-primary #E9EFF7, --text-dim
// #93A5BC, --accent-green #2E9E6B, --accent-amber #F5A623.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#0A1628', // app background (--bg-base)
          900: '#12233C', // panel background (--bg-panel)
          850: '#102138', // inset wells (inputs, inner panels)
          800: '#182C49', // raised panel / hover (--bg-panel2)
          700: '#24405F', // borders / strong divider (--bg-line)
          600: '#31598C',
        },
        table: {
          light: '#3FBF82',
          DEFAULT: '#2E9E6B', // primary green (--accent-green)
          dark: '#248457',
        },
        accent: {
          DEFAULT: '#F5A623', // amber accent (--accent-amber)
          dark: '#D98E0B',
        },
        ink: {
          DEFAULT: '#E9EFF7', // primary text (--text-primary)
          dim: '#93A5BC', // secondary text (--text-dim)
          faint: '#5F748E', // tertiary text
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(0,0,0,0.35)',
      },
    },
  },
  plugins: [],
};

export default config;
