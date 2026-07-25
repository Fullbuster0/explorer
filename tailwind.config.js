/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        yes: '#3fb68b',
        no: '#ff5353',
        info: '#00b2ff',
        main: 'var(--text-main)',
        secondary: 'var(--text-secondary)',
        active: 'var(--bg-active)',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 24px -16px rgba(15, 23, 42, 0.18)',
        glow: '0 0 0 1px rgba(0, 95, 204, 0.12), 0 12px 40px -18px rgba(0, 95, 204, 0.35)',
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        light: {
          ...require('daisyui/src/theming/themes')['[data-theme=light]'],
          primary: '#005fcc',
          'primary-content': '#ffffff',
          secondary: '#3385ff',
          accent: '#764bc8',
          'base-100': '#ffffff',
          'base-200': '#f4f7fc',
          'base-300': '#e6ecf5',
          'base-content': '#1a1f36',
        },
      },
      {
        dark: {
          ...require('daisyui/src/theming/themes')['[data-theme=dark]'],
          primary: '#99ccff',
          'primary-content': '#0a0e27',
          secondary: '#3385ff',
          accent: '#a78bfa',
          'base-100': '#0a0a0f',
          'base-200': '#0d0d14',
          'base-300': '#12121a',
          'base-content': '#e8ecf4',
        },
      },
    ],
  },
};
