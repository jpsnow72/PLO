import type { Config } from 'tailwindcss';

// Design tokens from the approved Stitch design ("PLO GTO Study"):
// dark navy background family, card-table green primary, amber accent.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#0A1628', // app background
          900: '#0E1E38', // panel background
          850: '#11233F',
          800: '#13294B', // raised panel / hover
          700: '#1B3A66', // borders / strong divider
          600: '#2A5298',
        },
        table: {
          light: '#3FBF82',
          DEFAULT: '#2E9E6B', // primary green
          dark: '#248457',
        },
        accent: {
          DEFAULT: '#F5A623', // amber accent
          dark: '#D98E0B',
        },
        ink: {
          DEFAULT: '#E8EEF6', // primary text
          dim: '#9FB2C8', // secondary text
          faint: '#647D99', // tertiary text
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
